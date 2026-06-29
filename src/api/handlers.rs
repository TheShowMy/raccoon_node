use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{header, Response},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use serde::Deserialize;
use tokio::task::JoinSet;
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};

use crate::error::AppError;
use crate::file_refs::{content_type_value, list_repo_files, read_attachment, save_attachment};
use crate::models::{
    AttachmentUploadRequest, ClarificationAnswerRequest, CurrentProjectResponse, FileReference,
    ImageAttachment, ModelSettings, ModelSettingsResponse, ProjectCanvasResponse,
    ProjectChatEventEmitter, ProjectChatMessageRequest, ProjectChatResponse,
    RequirementAnalysisInput, RequirementConversationResponse, RequirementEventEmitter,
    RequirementMessageRequest, RequirementStatus, RequirementTaskExecutionInput, RpcStatus,
};
use crate::store::{ProjectScheduleAction, TaskExecutionDisposition};
use crate::AppState;

static ACTIVE_EXECUTIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct ExecutionGuard(String);

impl ExecutionGuard {
    fn acquire(requirement_id: &str) -> Option<Self> {
        // ponytail: a process-wide lock is enough for this local single-process app.
        let mut active = ACTIVE_EXECUTIONS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .expect("execution lock poisoned");
        active
            .insert(requirement_id.to_owned())
            .then(|| Self(requirement_id.to_owned()))
    }
}

impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_EXECUTIONS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
        {
            active.remove(&self.0);
        }
    }
}

fn execution_is_active(requirement_id: &str) -> bool {
    ACTIVE_EXECUTIONS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("execution lock poisoned")
        .contains(requirement_id)
}

pub async fn get_current_project(
    State(state): State<AppState>,
) -> Result<Json<CurrentProjectResponse>, AppError> {
    let store = state.store.read().await;
    let project = store
        .data
        .projects
        .iter()
        .find(|project| project.id == crate::store::CURRENT_PROJECT_ID)
        .cloned()
        .ok_or_else(|| AppError::not_found("项目不存在"))?;
    Ok(Json(CurrentProjectResponse {
        project,
        theme: state.theme.clone(),
    }))
}

pub async fn get_project_canvas(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&id)?))
}

#[derive(Debug, Deserialize)]
pub struct ProjectFilesQuery {
    #[serde(default)]
    search: String,
}

pub async fn get_project_files(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ProjectFilesQuery>,
) -> Result<Json<Vec<FileReference>>, AppError> {
    let project = {
        let store = state.store.read().await;
        store
            .data
            .projects
            .iter()
            .find(|project| project.id == id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?
    };
    Ok(Json(
        list_repo_files(std::path::Path::new(&project.local_path), &query.search).await?,
    ))
}

pub async fn upload_project_attachment(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(payload): Json<AttachmentUploadRequest>,
) -> Result<Json<ImageAttachment>, AppError> {
    let project_dir = {
        let store = state.store.read().await;
        if !store.data.projects.iter().any(|project| project.id == id) {
            return Err(AppError::not_found("项目不存在"));
        }
        store.project_dir(&id)?
    };
    Ok(Json(save_attachment(&project_dir, payload).await?))
}

pub async fn get_project_attachment(
    State(state): State<AppState>,
    AxumPath((id, file)): AxumPath<(String, String)>,
) -> Result<Response<Body>, AppError> {
    let project_dir = {
        let store = state.store.read().await;
        if !store.data.projects.iter().any(|project| project.id == id) {
            return Err(AppError::not_found("项目不存在"));
        }
        store.project_dir(&id)?
    };
    let (bytes, mime_type) = read_attachment(&project_dir, &format!("attachments/{file}")).await?;
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type_value(mime_type));
    Ok(response)
}

pub async fn get_project_chat(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProjectChatResponse>, AppError> {
    let mut store = state.store.write().await;
    Ok(Json(store.project_chat_response(&id).await?))
}

pub async fn reset_project_chat(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProjectChatResponse>, AppError> {
    let mut store = state.store.write().await;
    Ok(Json(store.reset_project_chat(&id).await?))
}

pub async fn send_project_chat_message(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
    Json(payload): Json<ProjectChatMessageRequest>,
) -> Result<Json<ProjectChatResponse>, AppError> {
    let message = payload.message.trim().to_owned();
    if message.is_empty() {
        return Err(AppError::bad_request("项目问答内容不能为空"));
    }

    let (input, response) = {
        let mut store = state.store.write().await;
        store
            .start_project_chat_message(&project_id, message, payload.references, payload.images)
            .await?
    };
    spawn_project_chat_response(state, project_id, input);
    Ok(Json(response))
}

pub async fn get_requirement_conversation(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<RequirementConversationResponse>, AppError> {
    let store = state.store.read().await;
    Ok(Json(store.requirement_conversation(&id)?))
}

pub async fn create_requirement(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
    Json(payload): Json<RequirementMessageRequest>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let message = payload.message.trim().to_owned();
    if message.is_empty() {
        return Err(AppError::bad_request("需求内容不能为空"));
    }

    let (requirement_id, input) = {
        let mut store = state.store.write().await;
        store
            .create_requirement(&project_id, message, payload.references, payload.images)
            .await?
    };

    spawn_requirement_analysis(state.clone(), requirement_id, input);
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn append_requirement_message(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
    Json(payload): Json<RequirementMessageRequest>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let message = payload.message.trim().to_owned();
    if message.is_empty() {
        return Err(AppError::bad_request("补充说明不能为空"));
    }

    let (project_id, input) = {
        let mut store = state.store.write().await;
        store
            .append_requirement_message(
                &requirement_id,
                message,
                payload.references,
                payload.images,
            )
            .await?
    };

    spawn_requirement_analysis(state.clone(), requirement_id, input);
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn submit_requirement_clarifications(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
    Json(payload): Json<Vec<ClarificationAnswerRequest>>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let (project_id, input) = {
        let mut store = state.store.write().await;
        store
            .submit_requirement_clarifications(&requirement_id, payload)
            .await?
    };

    spawn_requirement_analysis(state.clone(), requirement_id, input);
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn requirement_events(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let stream =
        BroadcastStream::new(state.requirement_events.subscribe()).filter_map(move |result| {
            let requirement_id = requirement_id.clone();
            match result {
                Ok(event) if event.requirement_id == requirement_id => {
                    let event_name = event.event.clone();
                    let data = match serde_json::to_string(&event) {
                        Ok(json) => json,
                        Err(error) => {
                            tracing::error!(
                                requirement_id = %requirement_id,
                                event_name = %event_name,
                                error = %error,
                                "SSE event serialization failed"
                            );
                            r#"{"event":"serialization_failed","message":"事件序列化失败"}"#
                                .to_owned()
                        }
                    };
                    Some(Ok(Event::default().event(event_name).data(data)))
                }
                Ok(_) => None,
                Err(error) => {
                    tracing::warn!("SSE broadcast lagged: {}", error);
                    None
                }
            }
        });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub async fn project_chat_events(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let stream =
        BroadcastStream::new(state.project_chat_events.subscribe()).filter_map(move |result| {
            let project_id = project_id.clone();
            match result {
                Ok(event) if event.project_id == project_id => {
                    let event_name = event.event.clone();
                    let data = match serde_json::to_string(&event) {
                        Ok(json) => json,
                        Err(error) => {
                            tracing::error!(
                                project_id = %project_id,
                                event_name = %event_name,
                                error = %error,
                                "project chat SSE event serialization failed"
                            );
                            r#"{"event":"serialization_failed","message":"事件序列化失败"}"#
                                .to_owned()
                        }
                    };
                    Some(Ok(Event::default().event(event_name).data(data)))
                }
                Ok(_) => None,
                Err(error) => {
                    tracing::warn!("project chat SSE broadcast lagged: {}", error);
                    None
                }
            }
        });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub async fn confirm_requirement(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let project_id = {
        let mut store = state.store.write().await;
        store.confirm_requirement(&requirement_id).await?
    };
    spawn_project_scheduler(state.clone(), project_id.clone());
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn plan_requirement_execution(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let project_id = {
        let mut store = state.store.write().await;
        store.requeue_failed_planning(&requirement_id).await?
    };
    spawn_project_scheduler(state.clone(), project_id.clone());
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn retry_failed_node(
    State(state): State<AppState>,
    AxumPath((requirement_id, task_id)): AxumPath<(String, String)>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    if execution_is_active(&requirement_id) {
        return Err(AppError::bad_request("需求正在执行，请稍后再重试"));
    }
    let project_id = {
        let mut store = state.store.write().await;
        store.retry_failed_node(&requirement_id, &task_id).await?
    };
    spawn_project_scheduler(state.clone(), project_id.clone());
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn retry_from_node(
    State(state): State<AppState>,
    AxumPath((requirement_id, task_id)): AxumPath<(String, String)>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    if execution_is_active(&requirement_id) {
        return Err(AppError::bad_request("需求正在执行，请稍后再恢复"));
    }
    let project_id = {
        let mut store = state.store.write().await;
        store.retry_from_node(&requirement_id, &task_id).await?
    };
    spawn_project_scheduler(state.clone(), project_id.clone());
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn rerun_review(
    State(state): State<AppState>,
    AxumPath((requirement_id, task_id)): AxumPath<(String, String)>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    if execution_is_active(&requirement_id) {
        return Err(AppError::bad_request("需求正在执行，请稍后再重跑审核"));
    }
    let project_id = {
        let mut store = state.store.write().await;
        store.rerun_review(&requirement_id, &task_id).await?
    };
    spawn_project_scheduler(state.clone(), project_id.clone());
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn get_model_settings(
    State(state): State<AppState>,
) -> Result<Json<ModelSettingsResponse>, AppError> {
    let settings = {
        let store = state.store.read().await;
        store.data.model_settings.clone()
    };

    let response = match state.model_provider.available_models().await {
        Ok(models) => ModelSettingsResponse {
            models,
            settings,
            rpc_status: RpcStatus::Ready,
            rpc_error: None,
        },
        Err(error) => ModelSettingsResponse {
            models: Vec::new(),
            settings,
            rpc_status: RpcStatus::Error,
            rpc_error: Some(error.to_string()),
        },
    };

    Ok(Json(response))
}

pub async fn put_model_settings(
    State(state): State<AppState>,
    Json(payload): Json<ModelSettings>,
) -> Result<Json<ModelSettingsResponse>, AppError> {
    let models = state.model_provider.available_models().await?;
    {
        let mut store = state.store.write().await;
        store.save_model_settings(payload, &models).await?;
    }

    let store = state.store.read().await;
    Ok(Json(ModelSettingsResponse {
        models,
        settings: store.data.model_settings.clone(),
        rpc_status: RpcStatus::Ready,
        rpc_error: None,
    }))
}

pub async fn cancel_requirement_analysis(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<crate::models::ProjectCanvasResponse>, AppError> {
    // Find the project_id for this requirement.
    let project_id = {
        let store = state.store.read().await;
        let index = store
            .requirement_index(&requirement_id)
            .map_err(|_| AppError::not_found("需求不存在"))?;
        store.data.requirements[index].project_id.clone()
    };
    state
        .model_provider
        .cancel_requirement_analysis(&project_id)
        .await?;
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn delete_requirement(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<crate::models::ProjectCanvasResponse>, AppError> {
    let project_id = {
        let store = state.store.read().await;
        let index = store
            .requirement_index(&requirement_id)
            .map_err(|_| AppError::not_found("需求不存在"))?;
        store.data.requirements[index].project_id.clone()
    };
    state
        .model_provider
        .cancel_requirement_analysis(&project_id)
        .await?;
    {
        let mut store = state.store.write().await;
        store.delete_requirement(&requirement_id).await?;
    }
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

fn spawn_requirement_analysis(
    state: AppState,
    requirement_id: String,
    input: RequirementAnalysisInput,
) {
    tokio::spawn(async move {
        let emitter = RequirementEventEmitter {
            requirement_id: requirement_id.clone(),
            task_id: None,
            bus: state.requirement_events.clone(),
        };
        emitter.emit("coordinator_started", "Coordinator 开始分析需求。");

        let output = state
            .model_provider
            .analyze_requirement(input, Some(emitter.clone()))
            .await;

        let event = match &output {
            Ok(output) => {
                if !output.progress.trim().is_empty() {
                    emitter.emit("coordinator_progress", output.progress.trim());
                }
                match output.status {
                    RequirementStatus::Clarifying => {
                        ("clarifications_ready", "新的澄清问题已生成。")
                    }
                    RequirementStatus::DraftReady => ("draft_ready", "确认需求卡片已生成。"),
                    RequirementStatus::Failed => ("analysis_failed", "需求分析失败。"),
                    _ => ("coordinator_progress", "需求分析已更新。"),
                }
            }
            Err(error) => {
                let error_text = error.to_string();
                if error_text.contains("已被用户取消") {
                    ("analysis_cancelled", "分析已被取消")
                } else {
                    ("analysis_failed", "需求分析失败。")
                }
            }
        };

        {
            let mut store = state.store.write().await;
            if let Err(error) = store
                .apply_requirement_analysis(&requirement_id, output)
                .await
            {
                emitter.emit("analysis_failed", &format!("保存分析结果失败：{error}"));
                return;
            }
        }

        emitter.emit(event.0, event.1);
    });
}

fn spawn_project_chat_response(
    state: AppState,
    project_id: String,
    input: crate::models::ProjectChatInput,
) {
    tokio::spawn(async move {
        let emitter = ProjectChatEventEmitter {
            project_id: project_id.clone(),
            bus: state.project_chat_events.clone(),
        };
        emitter.emit("project_chat_started", "Pi Agent 开始回答项目问题。");

        let output = state
            .model_provider
            .ask_project_chat(input, Some(emitter.clone()))
            .await;
        let succeeded = output.is_ok();
        let failure = output.as_ref().err().map(ToString::to_string);

        let saved = {
            let mut store = state.store.write().await;
            store.apply_project_chat_result(&project_id, output).await
        };
        if let Err(error) = saved {
            emitter.emit(
                "project_chat_failed",
                &format!("保存项目问答结果失败：{error}"),
            );
            return;
        }

        if succeeded {
            emitter.emit("project_chat_completed", "项目问答已完成。");
        } else {
            emitter.emit(
                "project_chat_failed",
                failure.as_deref().unwrap_or("项目问答失败。"),
            );
        }
    });
}

pub(crate) fn spawn_startup_requirement_scheduler(state: AppState, project_ids: Vec<String>) {
    for project_id in project_ids {
        spawn_project_scheduler(state.clone(), project_id);
    }
}

fn spawn_project_scheduler(state: AppState, project_id: String) {
    let lock = {
        // ponytail: projects are few and app lifetime bounds this lock map.
        let mut locks = state
            .project_scheduler_locks
            .lock()
            .expect("project scheduler lock poisoned");
        locks
            .entry(project_id.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    tokio::spawn(async move {
        let _guard = lock.lock().await;
        run_project_scheduler(state, project_id).await;
    });
}

async fn run_project_scheduler(state: AppState, project_id: String) {
    loop {
        let action = {
            let mut store = state.store.write().await;
            match store.prepare_next_project_action(&project_id).await {
                Ok(action) => action,
                Err(error) => {
                    tracing::error!(project_id, %error, "project scheduler failed");
                    return;
                }
            }
        };
        match action {
            Some(ProjectScheduleAction::Plan {
                requirement_id,
                input,
            }) => {
                let emitter = RequirementEventEmitter {
                    requirement_id: requirement_id.clone(),
                    task_id: None,
                    bus: state.requirement_events.clone(),
                };
                emitter.emit("execution_planning_started", "开始拆分执行 DAG。");
                let output = state
                    .model_provider
                    .plan_requirement_execution(*input, Some(emitter.clone()))
                    .await;
                let succeeded = output.is_ok();
                {
                    let mut store = state.store.write().await;
                    if let Err(error) = store
                        .apply_requirement_execution_plan(&requirement_id, output)
                        .await
                    {
                        emitter.emit(
                            "execution_plan_failed",
                            &format!("保存执行 DAG 失败：{error}"),
                        );
                        return;
                    }
                }
                if succeeded {
                    emitter.emit("execution_plan_ready", "执行 DAG 已生成。");
                } else {
                    emitter.emit("execution_plan_failed", "执行 DAG 生成失败。");
                    return;
                }
            }
            Some(ProjectScheduleAction::Execute { requirement_id }) => {
                if run_requirement_execution(state.clone(), requirement_id).await
                    != RequirementStatus::Completed
                {
                    return;
                }
            }
            None => return,
        }
    }
}

async fn run_requirement_execution(state: AppState, requirement_id: String) -> RequirementStatus {
    let Some(execution_guard) = ExecutionGuard::acquire(&requirement_id) else {
        return current_requirement_status(&state, &requirement_id).await;
    };
    let _execution_guard = execution_guard;
    let emitter = RequirementEventEmitter {
        requirement_id: requirement_id.clone(),
        task_id: None,
        bus: state.requirement_events.clone(),
    };
    emitter.emit("execution_started", "开始按 DAG 执行任务。");
    let mut running_tasks = JoinSet::new();

    loop {
        let inputs = {
            let mut store = state.store.write().await;
            match store
                .prepare_runnable_execution_tasks(&requirement_id)
                .await
            {
                Ok(inputs) => inputs,
                Err(error) => {
                    let _ = store
                        .fail_requirement_execution(&requirement_id, error)
                        .await;
                    emitter.emit("execution_failed", "执行 DAG 依赖检查失败。");
                    return RequirementStatus::Failed;
                }
            }
        };

        spawn_execution_tasks(&mut running_tasks, inputs, state.clone(), &requirement_id);

        if running_tasks.is_empty() {
            let mut status = current_requirement_status(&state, &requirement_id).await;
            if status == RequirementStatus::Running {
                let mut store = state.store.write().await;
                let _ = store
                    .fail_requirement_execution(
                        &requirement_id,
                        AppError::internal("执行 DAG 没有可继续执行的任务"),
                    )
                    .await;
                status = RequirementStatus::Failed;
            }
            match status {
                RequirementStatus::Completed => {
                    emitter.emit("execution_completed", "需求执行完成。")
                }
                RequirementStatus::Failed => emitter.emit("execution_failed", "需求执行失败。"),
                _ => emitter.emit("execution_failed", "执行 DAG 没有可继续执行的任务。"),
            }
            return status;
        }

        let mut final_failure_seen = false;
        match running_tasks.join_next().await {
            Some(Ok(TaskExecutionDisposition::Continue)) => {}
            Some(Ok(TaskExecutionDisposition::FinalFailure)) | Some(Err(_)) => {
                final_failure_seen = true;
            }
            None => {}
        }

        if final_failure_seen {
            // 不 abort，让兄弟任务自然结束
            while running_tasks.join_next().await.is_some() {}
            let mut store = state.store.write().await;
            let _ = store.reset_running_execution_tasks(&requirement_id).await;
            emitter.emit("execution_failed", "需求执行失败。");
            return RequirementStatus::Failed;
        }
    }
}

async fn current_requirement_status(state: &AppState, requirement_id: &str) -> RequirementStatus {
    let store = state.store.read().await;
    store
        .requirement_status(requirement_id)
        .unwrap_or(RequirementStatus::Failed)
}

fn spawn_execution_tasks(
    running_tasks: &mut JoinSet<TaskExecutionDisposition>,
    inputs: Vec<RequirementTaskExecutionInput>,
    state: AppState,
    requirement_id: &str,
) {
    for input in inputs {
        let task_id = input.task.id.clone();
        let task_title = input.task.title.clone();
        let state = state.clone();
        let emitter = RequirementEventEmitter {
            requirement_id: requirement_id.to_owned(),
            task_id: Some(task_id.clone()),
            bus: state.requirement_events.clone(),
        };
        let requirement_id = requirement_id.to_owned();
        emitter.emit(
            "execution_task_started",
            &format!("开始执行任务：{}", task_title),
        );
        running_tasks.spawn(async move {
            let output = state
                .model_provider
                .execute_requirement_task(input, Some(emitter.clone()))
                .await;
            let succeeded = output.is_ok();
            let guidance_generated = output
                .as_ref()
                .ok()
                .is_some_and(|output| output.recovery_guidance.is_some());
            let disposition;
            {
                let mut store = state.store.write().await;
                disposition = match store
                    .apply_task_execution_result(&requirement_id, &task_id, output)
                    .await
                {
                    Ok(disposition) => disposition,
                    Err(error) => {
                        emitter.emit("execution_failed", &format!("保存任务结果失败：{error}"));
                        return TaskExecutionDisposition::FinalFailure;
                    }
                };
            }

            if guidance_generated {
                emitter.emit("execution_task_guided", "高档模型恢复方案已生成。");
            } else if succeeded {
                emitter.emit("execution_task_completed", "任务执行完成。");
            } else if disposition == TaskExecutionDisposition::Continue {
                emitter.emit("execution_task_retrying", "任务执行失败，已安排自动恢复。");
            } else {
                emitter.emit("execution_failed", "任务执行失败。");
            }
            disposition
        });
    }
}
use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
