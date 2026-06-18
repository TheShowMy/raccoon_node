use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};

use crate::error::AppError;
use crate::models::{
    AppData, ClarificationAnswerRequest, ModelSettings, ModelSettingsResponse, Project,
    ProjectCanvasResponse, RequirementAnalysisInput, RequirementEventBus, RequirementEventEmitter,
    RequirementMessageRequest, RequirementStatus, RpcStatus,
};
use crate::store::JsonStore;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<JsonStore>>,
    pub model_provider: Arc<dyn crate::models::ModelProvider>,
    pub requirement_events: RequirementEventBus,
}

pub async fn get_start(State(state): State<AppState>) -> Json<AppData> {
    let store = state.store.lock().await;
    Json(store.data.clone())
}

pub async fn create_project(
    State(state): State<AppState>,
    Json(payload): Json<crate::models::CreateProjectRequest>,
) -> Result<Json<Project>, AppError> {
    let mut store = state.store.lock().await;
    let project = store.create_project(payload.name, payload.git_url).await?;
    Ok(Json(project))
}

pub async fn delete_project(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    let mut store = state.store.lock().await;
    store.delete_project(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_project_canvas(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let store = state.store.lock().await;
    Ok(Json(store.project_canvas(&id)?))
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
        let mut store = state.store.lock().await;
        store.create_requirement(&project_id, message).await?
    };

    spawn_requirement_analysis(state.clone(), requirement_id, input);
    let store = state.store.lock().await;
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
        let mut store = state.store.lock().await;
        store
            .append_requirement_message(&requirement_id, message)
            .await?
    };

    spawn_requirement_analysis(state.clone(), requirement_id, input);
    let store = state.store.lock().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn submit_requirement_clarifications(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
    Json(payload): Json<Vec<ClarificationAnswerRequest>>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let (project_id, input) = {
        let mut store = state.store.lock().await;
        store
            .submit_requirement_clarifications(&requirement_id, payload)
            .await?
    };

    spawn_requirement_analysis(state.clone(), requirement_id, input);
    let store = state.store.lock().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn requirement_events(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let stream =
        BroadcastStream::new(state.requirement_events.tx.subscribe()).filter_map(move |event| {
            let requirement_id = requirement_id.clone();
            match event {
                Ok(event) if event.requirement_id == requirement_id => {
                    let event_name = event.event.clone();
                    let data = serde_json::to_string(&event).unwrap_or_else(|_| {
                        r#"{"event":"serialization_failed","message":"事件序列化失败"}"#.to_owned()
                    });
                    Some(Ok(Event::default().event(event_name).data(data)))
                }
                _ => None,
            }
        });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub async fn confirm_requirement(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let mut store = state.store.lock().await;
    let project_id = store.confirm_requirement(&requirement_id).await?;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn get_model_settings(
    State(state): State<AppState>,
) -> Result<Json<ModelSettingsResponse>, AppError> {
    let settings = {
        let store = state.store.lock().await;
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
        let mut store = state.store.lock().await;
        store.save_model_settings(payload, &models).await?;
    }

    let store = state.store.lock().await;
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
            let mut store = state.store.lock().await;
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
