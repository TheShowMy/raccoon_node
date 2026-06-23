use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};

use crate::error::AppError;
use crate::models::{
    AppData, ClarificationAnswerRequest, ModelSettings, ModelSettingsResponse, Project,
    ProjectCanvasResponse, RequirementAnalysisInput, RequirementConversationResponse,
    RequirementEventEmitter, RequirementMessageRequest, RequirementStatus, RpcStatus,
};
use crate::AppState;

pub async fn get_start(State(state): State<AppState>) -> Json<AppData> {
    let store = state.store.read().await;
    Json(store.data.clone())
}

pub async fn create_project(
    State(state): State<AppState>,
    Json(payload): Json<crate::models::CreateProjectRequest>,
) -> Result<Json<Project>, AppError> {
    let (id, repo_dir) = {
        let store = state.store.read().await;
        store.prepare_project(&payload.name, &payload.git_url)?
    };

    let name = payload.name.trim().to_owned();
    let git_url = payload.git_url.trim().to_owned();

    tokio::fs::create_dir_all(repo_dir.parent().unwrap()).await?;
    if let Err(error) = crate::utils::clone_git_repo(&git_url, &repo_dir).await {
        crate::utils::remove_dir_if_exists(&repo_dir).await?;
        return Err(error);
    }

    let mut store = state.store.write().await;
    let project = store.commit_project(id, name, git_url, repo_dir).await?;
    Ok(Json(project))
}

pub async fn delete_project(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    let mut store = state.store.write().await;
    store.delete_project(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_project_canvas(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&id)?))
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
        store.create_requirement(&project_id, message).await?
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
            .append_requirement_message(&requirement_id, message)
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

pub async fn confirm_requirement(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let project_id = {
        let mut store = state.store.write().await;
        store.confirm_requirement(&requirement_id).await?
    };
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn plan_requirement_execution(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let (project_id, input) = {
        let mut store = state.store.write().await;
        store.start_requirement_planning(&requirement_id).await?
    };
    spawn_requirement_execution_plan(state.clone(), requirement_id, input);
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn start_requirement_execution(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let project_id = {
        let mut store = state.store.write().await;
        store.start_requirement_execution(&requirement_id).await?
    };
    spawn_requirement_execution(state.clone(), requirement_id);
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn retry_failed_node(
    State(state): State<AppState>,
    AxumPath((requirement_id, task_id)): AxumPath<(String, String)>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let project_id = {
        let mut store = state.store.write().await;
        store.retry_failed_node(&requirement_id, &task_id).await?
    };
    spawn_requirement_execution(state.clone(), requirement_id);
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn retry_from_node(
    State(state): State<AppState>,
    AxumPath((requirement_id, task_id)): AxumPath<(String, String)>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let project_id = {
        let mut store = state.store.write().await;
        store.retry_from_node(&requirement_id, &task_id).await?
    };
    spawn_requirement_execution(state.clone(), requirement_id);
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn rerun_review(
    State(state): State<AppState>,
    AxumPath((requirement_id, task_id)): AxumPath<(String, String)>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let project_id = {
        let mut store = state.store.write().await;
        store.rerun_review(&requirement_id, &task_id).await?
    };
    spawn_requirement_execution(state.clone(), requirement_id);
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
            Err(_) => ("analysis_failed", "需求分析失败。"),
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

fn spawn_requirement_execution_plan(
    state: AppState,
    requirement_id: String,
    input: crate::models::RequirementPlanInput,
) {
    tokio::spawn(async move {
        let emitter = RequirementEventEmitter {
            requirement_id: requirement_id.clone(),
            task_id: None,
            bus: state.requirement_events.clone(),
        };
        emitter.emit("execution_planning_started", "开始拆分执行 DAG。");

        let output = state
            .model_provider
            .plan_requirement_execution(input, Some(emitter.clone()))
            .await;
        let event = if output.is_ok() {
            ("execution_plan_ready", "执行 DAG 已生成。")
        } else {
            ("execution_plan_failed", "执行 DAG 生成失败。")
        };

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

        emitter.emit(event.0, event.1);
    });
}

fn spawn_requirement_execution(state: AppState, requirement_id: String) {
    tokio::spawn(async move {
        let emitter = RequirementEventEmitter {
            requirement_id: requirement_id.clone(),
            task_id: None,
            bus: state.requirement_events.clone(),
        };
        emitter.emit("execution_started", "开始按 DAG 执行任务。");

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
                        return;
                    }
                }
            };

            if inputs.is_empty() {
                emitter.emit("execution_completed", "需求执行完成。");
                return;
            }

            let mut handles = Vec::with_capacity(inputs.len());
            for input in inputs {
                let task_id = input.task.id.clone();
                let task_title = input.task.title.clone();
                let state = state.clone();
                let emitter = emitter.for_task(task_id.clone());
                let requirement_id = requirement_id.clone();
                emitter.emit(
                    "execution_task_started",
                    &format!("开始执行任务：{}", task_title),
                );
                handles.push(tokio::spawn(async move {
                    let output = state
                        .model_provider
                        .execute_requirement_task(input, Some(emitter.clone()))
                        .await;
                    let succeeded = output.is_ok();
                    {
                        let mut store = state.store.write().await;
                        if let Err(error) = store
                            .apply_task_execution_result(&requirement_id, &task_id, output)
                            .await
                        {
                            emitter.emit("execution_failed", &format!("保存任务结果失败：{error}"));
                            return false;
                        }
                    }

                    if succeeded {
                        emitter.emit("execution_task_completed", "任务执行完成。");
                    } else {
                        emitter.emit("execution_failed", "任务执行失败。");
                    }
                    succeeded
                }));
            }

            for handle in handles {
                match handle.await {
                    Ok(true) => {}
                    Ok(false) | Err(_) => return,
                }
            }
        }
    });
}
