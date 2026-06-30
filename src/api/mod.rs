use axum::{
    http::{header, HeaderValue, Method, StatusCode},
    routing::{delete, get, post},
    Router,
};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

pub mod handlers;

async fn api_not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

use crate::api::handlers::{
    append_requirement_message, cancel_requirement_analysis, confirm_requirement,
    create_requirement, delete_requirement, get_basic_settings, get_current_project,
    get_model_settings, get_project_attachment, get_project_canvas, get_project_chat,
    get_project_files, get_requirement_conversation, plan_requirement_execution,
    project_chat_events, put_basic_settings, put_model_settings, recover_task_group,
    requirement_events, reset_project_chat, send_project_chat_message,
    spawn_startup_requirement_scheduler, submit_requirement_clarifications,
    upload_project_attachment,
};
use crate::pi_rpc::PiRpcModelProvider;
use crate::store::JsonStore;
use crate::AppState;

pub async fn build_app(
    data_path: PathBuf,
    project_root: PathBuf,
    config: Arc<tokio::sync::RwLock<crate::config::AppConfig>>,
    config_path: PathBuf,
    port_overridden: bool,
) -> (Router, AppState) {
    let mut store = JsonStore::open_project(data_path, project_root)
        .await
        .expect("failed to initialize json store");
    let startup_requirement_ids = store
        .recover_interrupted_requirements()
        .await
        .expect("failed to recover interrupted requirements");
    store
        .recover_interrupted_project_chats()
        .await
        .expect("failed to recover interrupted project chats");
    store.cleanup_stale_pi_sessions().await;
    let model_provider = PiRpcModelProvider::start(store.data_root.clone()).await;
    build_app_with_startup_requirements(
        store,
        Arc::new(model_provider),
        startup_requirement_ids,
        config,
        config_path,
        port_overridden,
    )
}

pub fn build_app_with_model_provider(
    store: JsonStore,
    _public_dir: PathBuf,
    model_provider: Arc<dyn crate::models::ModelProvider>,
) -> Router {
    let config_path = store.data_root.join("config.toml");
    build_app_with_startup_requirements(
        store,
        model_provider,
        Vec::new(),
        Arc::new(tokio::sync::RwLock::new(crate::config::AppConfig::default())),
        config_path,
        false,
    )
    .0
}

#[cfg(test)]
pub fn build_app_with_model_provider_and_config(
    store: JsonStore,
    model_provider: Arc<dyn crate::models::ModelProvider>,
    config: crate::config::AppConfig,
    port_overridden: bool,
) -> Router {
    let config_path = store.data_root.join("config.toml");
    build_app_with_startup_requirements(
        store,
        model_provider,
        Vec::new(),
        Arc::new(tokio::sync::RwLock::new(config)),
        config_path,
        port_overridden,
    )
    .0
}

fn build_app_with_startup_requirements(
    store: JsonStore,
    model_provider: Arc<dyn crate::models::ModelProvider>,
    startup_requirement_ids: Vec<String>,
    config: Arc<tokio::sync::RwLock<crate::config::AppConfig>>,
    config_path: PathBuf,
    port_overridden: bool,
) -> (Router, AppState) {
    let (event_tx, _) = broadcast::channel(256);
    let (project_chat_tx, _) = broadcast::channel(256);
    let state = AppState {
        store: Arc::new(tokio::sync::RwLock::new(store)),
        model_provider,
        requirement_events: event_tx,
        project_chat_events: project_chat_tx,
        config,
        config_path,
        port_overridden,
        project_scheduler_locks: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    };

    let api = Router::new()
        .route("/project/current", get(get_current_project))
        .route("/projects/{id}/canvas", get(get_project_canvas))
        .route("/projects/{id}/files", get(get_project_files))
        .route(
            "/projects/{id}/attachments",
            post(upload_project_attachment),
        )
        .route(
            "/projects/{id}/attachments/{file}",
            get(get_project_attachment),
        )
        .route(
            "/projects/{id}/chat",
            get(get_project_chat).delete(reset_project_chat),
        )
        .route(
            "/projects/{id}/chat/messages",
            post(send_project_chat_message),
        )
        .route("/projects/{id}/chat/events", get(project_chat_events))
        .route("/projects/{id}/requirements", post(create_requirement))
        .route(
            "/requirements/{id}/messages",
            post(append_requirement_message),
        )
        .route(
            "/requirements/{id}/conversation",
            get(get_requirement_conversation),
        )
        .route(
            "/requirements/{id}/clarifications",
            post(submit_requirement_clarifications),
        )
        .route("/requirements/{id}/events", get(requirement_events))
        .route("/requirements/{id}/confirm", post(confirm_requirement))
        .route("/requirements/{id}/plan", post(plan_requirement_execution))
        .route(
            "/requirements/{id}/tasks/{task_id}/recover",
            post(recover_task_group),
        )
        .route(
            "/requirements/{id}/cancel",
            post(cancel_requirement_analysis),
        )
        .route("/requirements/{id}", delete(delete_requirement))
        .route(
            "/settings/models",
            get(get_model_settings).put(put_model_settings),
        )
        .route(
            "/settings/basic",
            get(get_basic_settings).put(put_basic_settings),
        )
        .fallback(api_not_found)
        .with_state(state.clone());

    let allowed_origins: Vec<HeaderValue> = if cfg!(debug_assertions) {
        vec![
            "http://127.0.0.1:5173".parse::<HeaderValue>().unwrap(),
            "http://localhost:5173".parse::<HeaderValue>().unwrap(),
        ]
    } else {
        vec![]
    };
    let app = Router::new()
        .nest("/api", api)
        .fallback(crate::assets::serve)
        .layer(
            CorsLayer::new()
                .allow_origin(allowed_origins)
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
                .allow_headers([header::CONTENT_TYPE]),
        );
    spawn_startup_requirement_scheduler(state.clone(), startup_requirement_ids);
    (app, state)
}
