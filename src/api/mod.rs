use axum::{
    Router,
    http::{HeaderValue, Method, StatusCode, header},
    routing::{delete, get, post},
};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

mod assets;
pub mod git;
pub mod handlers;
pub mod publication;
pub mod terminal;

async fn api_not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

use crate::api::git::{execute_git_action, get_git_diff, get_git_status};
use crate::api::handlers::{
    abort_project_chat, append_requirement_message, cancel_requirement_analysis,
    confirm_requirement, create_project_terminal, create_requirement, create_requirement_branch,
    delete_project_terminal, delete_requirement, get_basic_settings, get_current_project,
    get_model_settings, get_project_attachment, get_project_canvas, get_project_chat,
    get_project_chat_session, get_project_file_content, get_project_file_tree, get_project_files,
    get_requirement_conversation, get_requirement_session, get_requirement_task,
    get_requirement_task_session, get_terminal_access_status, get_terminal_command_profiles,
    list_project_terminals, plan_requirement_execution, project_chat_events, put_basic_settings,
    put_model_settings, put_terminal_command_profiles, recover_task_group, reload_model_settings,
    requirement_conversation_events, requirement_events, reset_project_chat, restart_system,
    retry_requirement_analysis, send_project_chat_message, spawn_startup_requirement_scheduler,
    submit_requirement_clarifications, terminal_websocket, unlock_terminal_access,
    upload_project_attachment,
};
use crate::pi::PiRpcModelProvider;
use crate::store::JsonStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleCommand {
    Restart,
}

#[derive(Clone, Default)]
pub struct RuntimeOptions {
    pub host_override: Option<String>,
    pub port_override: Option<u16>,
    pub effective_host: Option<String>,
    pub effective_port: Option<u16>,
    pub dev_frontend_url: Option<String>,
    pub lifecycle_tx: Option<tokio::sync::mpsc::UnboundedSender<LifecycleCommand>>,
}

#[derive(Clone)]
pub struct AppState {
    pub store: std::sync::Arc<tokio::sync::RwLock<JsonStore>>,
    pub model_provider: std::sync::Arc<dyn crate::models::ModelProvider>,
    pub requirement_events: crate::models::RequirementEventBus,
    pub project_chat_events: crate::models::ProjectChatEventBus,
    pub terminal_manager: std::sync::Arc<terminal::TerminalManager>,
    pub terminal_access: std::sync::Arc<terminal::TerminalAccess>,
    pub project_root: std::path::PathBuf,
    pub config: std::sync::Arc<tokio::sync::RwLock<crate::config::AppConfig>>,
    pub config_path: std::path::PathBuf,
    pub runtime: RuntimeOptions,
    pub publication_readiness:
        std::sync::Arc<tokio::sync::RwLock<crate::models::PublicationReadiness>>,
    pub pending_startup_requirement_ids: std::sync::Arc<tokio::sync::Mutex<Vec<String>>>,
    pub project_scheduler_locks: std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
    >,
    pub pending_requirement_interactions:
        std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, (String, String)>>>,
    pub active_requirement_analyses:
        std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

pub async fn build_app(
    project_root: PathBuf,
    config: Arc<tokio::sync::RwLock<crate::config::AppConfig>>,
    config_path: PathBuf,
    runtime: RuntimeOptions,
    publication_readiness: crate::models::PublicationReadiness,
) -> Result<(Router, AppState), crate::error::AppError> {
    let mut store = JsonStore::open_project(project_root.clone()).await?;
    let startup_requirement_ids = store.recover_interrupted_requirements().await?;
    store.recover_interrupted_project_chats().await?;
    store.cleanup_stale_pi_sessions().await;
    let model_provider = PiRpcModelProvider::start(store.data_root.clone()).await;
    Ok(build_app_with_startup_requirements(
        store,
        Arc::new(model_provider),
        startup_requirement_ids,
        config,
        config_path,
        runtime,
        publication_readiness,
    ))
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
        RuntimeOptions::default(),
        crate::models::PublicationReadiness::local(),
    )
    .0
}

#[doc(hidden)]
pub fn build_app_with_model_provider_and_config(
    store: JsonStore,
    model_provider: Arc<dyn crate::models::ModelProvider>,
    config: crate::config::AppConfig,
    port_overridden: bool,
) -> Router {
    let config_path = store.data_root.join("config.toml");
    let port_override = port_overridden.then_some(config.port);
    let effective_host = Some(config.host.clone());
    let effective_port = Some(config.port);
    build_app_with_startup_requirements(
        store,
        model_provider,
        Vec::new(),
        Arc::new(tokio::sync::RwLock::new(config)),
        config_path,
        RuntimeOptions {
            port_override,
            effective_host,
            effective_port,
            ..RuntimeOptions::default()
        },
        crate::models::PublicationReadiness::local(),
    )
    .0
}

#[doc(hidden)]
pub fn build_app_with_model_provider_and_runtime(
    store: JsonStore,
    model_provider: Arc<dyn crate::models::ModelProvider>,
    config: crate::config::AppConfig,
    runtime: RuntimeOptions,
) -> (Router, AppState) {
    let config_path = store.data_root.join("config.toml");
    build_app_with_startup_requirements(
        store,
        model_provider,
        Vec::new(),
        Arc::new(tokio::sync::RwLock::new(config)),
        config_path,
        runtime,
        crate::models::PublicationReadiness::local(),
    )
}

fn build_app_with_startup_requirements(
    store: JsonStore,
    model_provider: Arc<dyn crate::models::ModelProvider>,
    startup_requirement_ids: Vec<String>,
    config: Arc<tokio::sync::RwLock<crate::config::AppConfig>>,
    config_path: PathBuf,
    runtime: RuntimeOptions,
    publication_readiness: crate::models::PublicationReadiness,
) -> (Router, AppState) {
    let (event_tx, _) = broadcast::channel(256);
    let (project_chat_tx, _) = broadcast::channel(256);
    let project_root = store
        .data_root
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| store.data_root.clone());
    let state = AppState {
        store: Arc::new(tokio::sync::RwLock::new(store)),
        model_provider,
        requirement_events: event_tx,
        project_chat_events: project_chat_tx,
        terminal_manager: Arc::new(terminal::TerminalManager::new()),
        terminal_access: Arc::new(terminal::TerminalAccess::new()),
        project_root,
        config,
        config_path,
        runtime,
        publication_readiness: Arc::new(tokio::sync::RwLock::new(publication_readiness)),
        pending_startup_requirement_ids: Arc::new(tokio::sync::Mutex::new(startup_requirement_ids)),
        project_scheduler_locks: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        pending_requirement_interactions: Arc::new(tokio::sync::Mutex::new(
            std::collections::HashMap::new(),
        )),
        active_requirement_analyses: Arc::new(std::sync::Mutex::new(
            std::collections::HashSet::new(),
        )),
    };

    let api = Router::new()
        .route("/project/current", get(get_current_project))
        .route("/projects/{id}/canvas", get(get_project_canvas))
        .route("/projects/{id}/files", get(get_project_files))
        .route("/projects/{id}/files/tree", get(get_project_file_tree))
        .route(
            "/projects/{id}/files/content",
            get(get_project_file_content),
        )
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
        .route("/projects/{id}/chat/session", get(get_project_chat_session))
        .route(
            "/projects/{id}/chat/messages",
            post(send_project_chat_message),
        )
        .route("/projects/{id}/chat/events", get(project_chat_events))
        .route(
            "/projects/{id}/chat/commands/requirement-branch",
            post(create_requirement_branch),
        )
        .route("/projects/{id}/chat/abort", post(abort_project_chat))
        .route(
            "/projects/{id}/terminals",
            get(list_project_terminals).post(create_project_terminal),
        )
        .route(
            "/projects/{id}/terminals/{terminal_id}",
            delete(delete_project_terminal),
        )
        .route(
            "/projects/{id}/terminals/{terminal_id}/ws",
            get(terminal_websocket),
        )
        .route(
            "/projects/{id}/terminal-commands",
            get(get_terminal_command_profiles).put(put_terminal_command_profiles),
        )
        .route(
            "/projects/{id}/terminal-access",
            get(get_terminal_access_status).post(unlock_terminal_access),
        )
        .route("/projects/{id}/git/status", get(get_git_status))
        .route("/projects/{id}/git/diff", get(get_git_diff))
        .route("/projects/{id}/git/actions", post(execute_git_action))
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
            "/requirements/{id}/conversation/events",
            get(requirement_conversation_events),
        )
        .route("/requirements/{id}/session", get(get_requirement_session))
        .route(
            "/requirements/{id}/clarifications",
            post(submit_requirement_clarifications),
        )
        .route("/requirements/{id}/events", get(requirement_events))
        .route(
            "/requirements/{id}/retry-analysis",
            post(retry_requirement_analysis),
        )
        .route("/requirements/{id}/confirm", post(confirm_requirement))
        .route("/requirements/{id}/plan", post(plan_requirement_execution))
        .route(
            "/requirements/{id}/tasks/{task_id}",
            get(get_requirement_task),
        )
        .route(
            "/requirements/{id}/tasks/{task_id}/session",
            get(get_requirement_task_session),
        )
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
        .route("/settings/models/reload", post(reload_model_settings))
        .route(
            "/settings/basic",
            get(get_basic_settings).put(put_basic_settings),
        )
        .route("/system/restart", post(restart_system))
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
        .fallback(crate::api::assets::serve)
        .layer(
            CorsLayer::new()
                .allow_origin(allowed_origins)
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
                .allow_headers([header::CONTENT_TYPE]),
        );
    spawn_startup_requirement_scheduler(state.clone());
    (app, state)
}
