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
    append_requirement_message, confirm_requirement, create_project, create_requirement,
    delete_project, get_model_settings, get_project_canvas, get_start, put_model_settings,
    requirement_events, submit_requirement_clarifications, AppState,
};
use crate::models::RequirementEventBus;
use crate::pi_rpc::PiRpcModelProvider;
use crate::store::JsonStore;

pub async fn build_app(data_path: PathBuf, public_dir: PathBuf) -> Router {
    let store = JsonStore::open(data_path)
        .await
        .expect("failed to initialize json store");
    let model_provider = PiRpcModelProvider::start(store.data_root.clone()).await;
    build_app_with_model_provider(store, public_dir, Arc::new(model_provider))
}

pub fn build_app_with_model_provider(
    store: JsonStore,
    public_dir: PathBuf,
    model_provider: Arc<dyn crate::models::ModelProvider>,
) -> Router {
    let (event_tx, _) = broadcast::channel(256);
    let state = AppState {
        store: Arc::new(tokio::sync::RwLock::new(store)),
        model_provider,
        requirement_events: RequirementEventBus { tx: event_tx },
    };

    let api = Router::new()
        .route("/start", get(get_start))
        .route("/projects", post(create_project))
        .route("/projects/{id}", delete(delete_project))
        .route("/projects/{id}/canvas", get(get_project_canvas))
        .route("/projects/{id}/requirements", post(create_requirement))
        .route(
            "/requirements/{id}/messages",
            post(append_requirement_message),
        )
        .route(
            "/requirements/{id}/clarifications",
            post(submit_requirement_clarifications),
        )
        .route("/requirements/{id}/events", get(requirement_events))
        .route("/requirements/{id}/confirm", post(confirm_requirement))
        .route(
            "/settings/models",
            get(get_model_settings).put(put_model_settings),
        )
        .with_state(state);

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
    Router::new()
        .nest("/api", api)
        .fallback_service(static_files)
        .layer(
            CorsLayer::new()
                .allow_origin(allowed_origins)
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
                .allow_headers([header::CONTENT_TYPE]),
        )
}
