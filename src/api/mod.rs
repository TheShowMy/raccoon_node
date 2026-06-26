use axum::{
    http::{header, HeaderValue, Method},
    routing::{delete, get, post},
    Router,
};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::broadcast;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};

pub mod handlers;

use crate::api::handlers::{
    append_requirement_message, cancel_requirement_analysis, confirm_requirement, create_project,
    create_requirement, delete_project, delete_requirement, get_model_settings, get_project_canvas,
    get_project_chat, get_requirement_conversation, get_start, plan_requirement_execution,
    project_chat_events, put_model_settings, requirement_events, rerun_review, retry_failed_node,
    retry_from_node, send_project_chat_message, spawn_startup_requirement_scheduler,
    submit_requirement_clarifications,
};
use crate::pi_rpc::PiRpcModelProvider;
use crate::store::JsonStore;
use crate::AppState;

pub async fn build_app(data_path: PathBuf, public_dir: PathBuf) -> Router {
    let mut store = JsonStore::open(data_path)
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
        public_dir,
        Arc::new(model_provider),
        startup_requirement_ids,
    )
}

pub fn build_app_with_model_provider(
    store: JsonStore,
    public_dir: PathBuf,
    model_provider: Arc<dyn crate::models::ModelProvider>,
) -> Router {
    build_app_with_startup_requirements(store, public_dir, model_provider, Vec::new())
}

fn build_app_with_startup_requirements(
    store: JsonStore,
    public_dir: PathBuf,
    model_provider: Arc<dyn crate::models::ModelProvider>,
    startup_requirement_ids: Vec<String>,
) -> Router {
    let (event_tx, _) = broadcast::channel(256);
    let (project_chat_tx, _) = broadcast::channel(256);
    let state = AppState {
        store: Arc::new(tokio::sync::RwLock::new(store)),
        model_provider,
        requirement_events: event_tx,
        project_chat_events: project_chat_tx,
        project_scheduler_locks: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    };

    let api = Router::new()
        .route("/start", get(get_start))
        .route("/projects", post(create_project))
        .route("/projects/{id}", delete(delete_project))
        .route("/projects/{id}/canvas", get(get_project_canvas))
        .route("/projects/{id}/chat", get(get_project_chat))
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
            "/requirements/{id}/tasks/{task_id}/retry",
            post(retry_failed_node),
        )
        .route(
            "/requirements/{id}/tasks/{task_id}/retry-from",
            post(retry_from_node),
        )
        .route(
            "/requirements/{id}/tasks/{task_id}/rerun-review",
            post(rerun_review),
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
        .with_state(state.clone());

    let static_files =
        ServeDir::new(&public_dir).fallback(ServeFile::new(public_dir.join("index.html")));

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
        .fallback_service(static_files)
        .layer(
            CorsLayer::new()
                .allow_origin(allowed_origins)
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
                .allow_headers([header::CONTENT_TYPE]),
        );
    spawn_startup_requirement_scheduler(state, startup_requirement_ids);
    app
}
