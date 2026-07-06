use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};

use axum::{
    Json,
    body::Body,
    extract::{
        Path as AxumPath, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{Response, header},
    response::{
        IntoResponse,
        sse::{Event, KeepAlive, Sse},
    },
};
use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;
use tokio_stream::{Stream, StreamExt, wrappers::BroadcastStream};

use crate::api::AppState;
use crate::file_refs::{
    content_type_value, list_repo_files, read_attachment, read_repo_file, save_attachment,
};
use crate::models::{
    AttachmentUploadRequest, BasicSettings, BasicSettingsUpdate, ClarificationAnswerPayload,
    CurrentProjectResponse, FileReference, ImageAttachment, ModelSettings, ModelSettingsResponse,
    ProjectCanvasResponse, ProjectChatEventEmitter, ProjectChatMessageRequest, ProjectChatResponse,
    ProjectFileContent, RequirementAnalysisInput, RequirementClarification,
    RequirementConfirmRequest, RequirementConversationResponse, RequirementEvent,
    RequirementEventEmitter, RequirementMessageRequest, RequirementStatus,
    RequirementTaskDetailResponse, RequirementTaskExecutionInput, RpcStatus, SessionTranscriptPage,
    TerminalAccessRequest, TerminalAccessStatus, TerminalClientMessage, TerminalCommandProfile,
    TerminalCommandProfilesUpdate, TerminalLaunchRequest, TerminalServerMessage, TerminalSession,
};
use crate::store::{ProjectScheduleAction, TaskExecutionDisposition};
use crate::{config::CommitMode, error::AppError};

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
        theme: state.config.read().await.theme.as_str().to_owned(),
        publication_readiness: state.publication_readiness.read().await.clone(),
    }))
}

pub async fn get_basic_settings(
    State(state): State<AppState>,
) -> Result<Json<BasicSettings>, AppError> {
    let config = state.config.read().await;
    Ok(Json(basic_settings_response(&state, &config)))
}

pub async fn put_basic_settings(
    State(state): State<AppState>,
    Json(payload): Json<BasicSettingsUpdate>,
) -> Result<Json<BasicSettings>, AppError> {
    if payload
        .port
        .is_some_and(|port| !(1..=u16::MAX as u32).contains(&port))
    {
        return Err(AppError::bad_request("端口必须在 1 到 65535 之间"));
    }
    if payload.host.as_deref() == Some("0.0.0.0") && !payload.confirmed_external {
        return Err(AppError::bad_request(
            "监听 0.0.0.0 会将无鉴权 API 暴露到所有网络接口，请先确认风险",
        ));
    }

    let current = state.config.read().await.clone();
    let readiness = if payload
        .commit_mode
        .is_some_and(|mode| mode != current.commit_mode)
    {
        let checked_mode = payload.commit_mode.unwrap_or(current.commit_mode);
        let readiness = crate::api::publication::check(
            &state.project_root,
            &crate::utils::git_remote_origin(&state.project_root),
            checked_mode,
        )
        .await;
        if checked_mode == CommitMode::PullRequest && !readiness.ready {
            return Err(AppError::conflict(format!(
                "当前不满足 PR 合并条件：{}",
                readiness.issues.join("；")
            )));
        }
        Some(readiness)
    } else {
        None
    };

    let mut config = state.config.write().await;
    let updated = crate::config::AppConfig {
        theme: payload.theme.unwrap_or(config.theme),
        host: payload.host.clone().unwrap_or_else(|| config.host.clone()),
        port: payload.port.map(|port| port as u16).unwrap_or(config.port),
        commit_mode: payload.commit_mode.unwrap_or(config.commit_mode),
    };
    updated
        .validate()
        .map_err(|error| AppError::bad_request(error.to_string()))?;
    updated.save(&state.config_path)?;
    *config = updated;
    drop(config);

    if let Some(readiness) = readiness {
        *state.publication_readiness.write().await = readiness;
        spawn_startup_requirement_scheduler(state.clone());
    }
    let config = state.config.read().await;

    Ok(Json(basic_settings_response(&state, &config)))
}

fn basic_settings_response(state: &AppState, config: &crate::config::AppConfig) -> BasicSettings {
    let desired_host = state
        .runtime
        .host_override
        .clone()
        .unwrap_or_else(|| config.host.clone());
    let desired_port = state.runtime.port_override.unwrap_or(config.port);
    let restart_required = state
        .runtime
        .effective_host
        .as_ref()
        .is_some_and(|effective| effective != &desired_host)
        || state
            .runtime
            .effective_port
            .is_some_and(|effective| effective != desired_port);
    BasicSettings {
        theme: config.theme,
        host: config.host.clone(),
        port: config.port,
        host_overridden: state.runtime.host_override.is_some(),
        port_overridden: state.runtime.port_override.is_some(),
        effective_host: state
            .runtime
            .effective_host
            .clone()
            .unwrap_or_else(|| desired_host.clone()),
        effective_port: state.runtime.effective_port.unwrap_or(desired_port),
        restart_required,
        commit_mode: config.commit_mode,
    }
}

pub async fn get_project_canvas(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ProjectCanvasQuery>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let store = state.store.read().await;
    Ok(Json(store.project_canvas_for_view(
        &id,
        query.dag_requirement_id.as_deref(),
    )?))
}

#[derive(Debug, Deserialize)]
pub struct ProjectCanvasQuery {
    dag_requirement_id: Option<String>,
}

pub async fn get_requirement_task(
    State(state): State<AppState>,
    AxumPath((requirement_id, task_id)): AxumPath<(String, String)>,
) -> Result<Json<RequirementTaskDetailResponse>, AppError> {
    let store = state.store.read().await;
    Ok(Json(
        store.requirement_task_detail(&requirement_id, &task_id)?,
    ))
}

pub async fn get_requirement_task_session(
    State(state): State<AppState>,
    AxumPath((requirement_id, task_id)): AxumPath<(String, String)>,
    Query(query): Query<SessionPageQuery>,
) -> Result<Json<SessionTranscriptPage>, AppError> {
    let sources = {
        let store = state.store.read().await;
        store.requirement_task_session_sources(&requirement_id, &task_id)?
    };
    read_session_page(sources, query).await
}

pub async fn get_requirement_session(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
    Query(query): Query<SessionPageQuery>,
) -> Result<Json<SessionTranscriptPage>, AppError> {
    let sources = {
        let store = state.store.read().await;
        store.requirement_session_sources(&requirement_id)?
    };
    read_session_page(sources, query).await
}

pub async fn get_project_chat_session(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
    Query(query): Query<SessionPageQuery>,
) -> Result<Json<SessionTranscriptPage>, AppError> {
    let sources = {
        let store = state.store.read().await;
        store.project_chat_session_sources(&project_id)?
    };
    read_session_page(sources, query).await
}

#[derive(Debug, Deserialize)]
pub struct SessionPageQuery {
    before: Option<usize>,
    #[serde(default = "default_session_page_size")]
    limit: usize,
}

fn default_session_page_size() -> usize {
    100
}

async fn read_session_page(
    sources: Vec<(String, std::path::PathBuf)>,
    query: SessionPageQuery,
) -> Result<Json<SessionTranscriptPage>, AppError> {
    let response = tokio::task::spawn_blocking(move || {
        crate::store::read_session_transcript(&sources, query.before, query.limit)
    })
    .await
    .map_err(|_| AppError::internal("读取会话记录失败"))??;
    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
pub struct ProjectFilesQuery {
    #[serde(default)]
    search: String,
}

#[derive(Debug, Deserialize)]
pub struct ProjectFileContentQuery {
    path: String,
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

pub async fn get_project_file_content(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ProjectFileContentQuery>,
) -> Result<Json<ProjectFileContent>, AppError> {
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
    Ok(Json(ProjectFileContent {
        path: query.path.clone(),
        content: read_repo_file(std::path::Path::new(&project.local_path), &query.path).await?,
    }))
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
    Json(payload): Json<ClarificationAnswerPayload>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let (prompt_id, revision, answers) = payload.into_parts();
    let (project_id, input) = {
        let mut store = state.store.write().await;
        store
            .submit_requirement_clarifications(&requirement_id, prompt_id, revision, answers)
            .await?
    };
    state
        .pending_requirement_interactions
        .lock()
        .await
        .remove(&requirement_id);
    spawn_requirement_analysis(state.clone(), requirement_id, input);
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn retry_requirement_analysis(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    state
        .pending_requirement_interactions
        .lock()
        .await
        .remove(&requirement_id);
    let (project_id, input) = {
        let mut store = state.store.write().await;
        store.retry_requirement_analysis(&requirement_id).await?
    };
    spawn_requirement_analysis(state.clone(), requirement_id, input);
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn requirement_events(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
    Query(query): Query<RequirementEventsQuery>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let stream =
        BroadcastStream::new(state.requirement_events.subscribe()).filter_map(move |result| {
            let requirement_id = requirement_id.clone();
            match result {
                Ok(event) if requirement_event_matches(&event, &requirement_id, &query) => {
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

#[derive(Debug, Clone, Deserialize)]
pub struct RequirementEventsQuery {
    #[serde(default = "default_true")]
    include_pi_events: bool,
}

fn default_true() -> bool {
    true
}

fn requirement_event_matches(
    event: &RequirementEvent,
    requirement_id: &str,
    query: &RequirementEventsQuery,
) -> bool {
    event.requirement_id == requirement_id && (query.include_pi_events || event.event != "pi_event")
}

pub async fn list_project_terminals(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
) -> Result<Json<Vec<TerminalSession>>, AppError> {
    ensure_terminal_allowed(&state).await?;
    {
        let store = state.store.read().await;
        store.project_root(&project_id)?;
    }
    Ok(Json(state.terminal_manager.list(&project_id)))
}

pub async fn get_terminal_access_status(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
) -> Result<Json<TerminalAccessStatus>, AppError> {
    {
        let store = state.store.read().await;
        store.project_root(&project_id)?;
    }
    Ok(Json(
        state
            .terminal_access
            .status(terminal_access_required(&state).await),
    ))
}

pub async fn unlock_terminal_access(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
    Json(payload): Json<TerminalAccessRequest>,
) -> Result<Json<TerminalAccessStatus>, AppError> {
    {
        let store = state.store.read().await;
        store.project_root(&project_id)?;
    }
    if !terminal_access_required(&state).await {
        return Ok(Json(state.terminal_access.status(false)));
    }
    Ok(Json(state.terminal_access.authorize(&payload.key)?))
}

pub async fn create_project_terminal(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
    Json(payload): Json<TerminalLaunchRequest>,
) -> Result<Json<TerminalSession>, AppError> {
    ensure_terminal_allowed(&state).await?;
    let project_root = {
        let store = state.store.read().await;
        store.project_root(&project_id)?
    };
    state.terminal_manager.cleanup_exited();
    Ok(Json(state.terminal_manager.spawn(
        &project_id,
        project_root,
        payload.command,
        payload.title,
        payload.rows,
        payload.cols,
    )?))
}

pub async fn delete_project_terminal(
    State(state): State<AppState>,
    AxumPath((project_id, terminal_id)): AxumPath<(String, String)>,
) -> Result<Json<Vec<TerminalSession>>, AppError> {
    ensure_terminal_allowed(&state).await?;
    state.terminal_manager.delete(&project_id, &terminal_id)?;
    Ok(Json(state.terminal_manager.list(&project_id)))
}

pub async fn get_terminal_command_profiles(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
) -> Result<Json<Vec<TerminalCommandProfile>>, AppError> {
    ensure_terminal_allowed(&state).await?;
    let store = state.store.read().await;
    Ok(Json(store.terminal_command_profiles(&project_id)?))
}

pub async fn put_terminal_command_profiles(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
    Json(payload): Json<TerminalCommandProfilesUpdate>,
) -> Result<Json<Vec<TerminalCommandProfile>>, AppError> {
    ensure_terminal_allowed(&state).await?;
    let mut store = state.store.write().await;
    Ok(Json(
        store
            .replace_terminal_command_profiles(&project_id, payload.profiles)
            .await?,
    ))
}

pub async fn terminal_websocket(
    State(state): State<AppState>,
    AxumPath((project_id, terminal_id)): AxumPath<(String, String)>,
    websocket: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    ensure_terminal_allowed(&state).await?;
    {
        let store = state.store.read().await;
        store.project_root(&project_id)?;
    }
    let session = state.terminal_manager.get(&terminal_id)?;
    if session.metadata().project_id != project_id {
        return Err(AppError::not_found("终端不存在"));
    }
    let terminal_access = state.terminal_access.clone();
    let authorization_required = terminal_access_required(&state).await;
    Ok(websocket.on_upgrade(move |socket| {
        handle_terminal_socket(socket, session, terminal_access, authorization_required)
    }))
}

async fn handle_terminal_socket(
    mut socket: WebSocket,
    session: std::sync::Arc<crate::api::terminal::TerminalSessionRuntime>,
    terminal_access: std::sync::Arc<crate::api::terminal::TerminalAccess>,
    authorization_required: bool,
) {
    let mut output_rx = session.subscribe();
    let access_duration = if authorization_required {
        terminal_access.duration_until_expiry().unwrap_or_default()
    } else {
        std::time::Duration::from_secs(365 * 24 * 60 * 60)
    };
    let mut access_expiry = Box::pin(tokio::time::sleep(access_duration));
    let status_message = TerminalServerMessage::Status {
        status: session.metadata().status,
        exit_code: session.metadata().exit_code,
    };
    if let Ok(message) = serde_json::to_string(&status_message)
        && socket.send(Message::Text(message.into())).await.is_err()
    {
        return;
    }
    for message in session.output_history() {
        let Ok(data) = serde_json::to_string(&message) else {
            continue;
        };
        if socket.send(Message::Text(data.into())).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            output = output_rx.recv() => {
                match output {
                    Ok(message) => {
                        match serde_json::to_string(&message) {
                            Ok(data) => {
                                if socket.send(Message::Text(data.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(error) => tracing::error!(error = %error, "terminal websocket event serialization failed"),
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = &mut access_expiry, if authorization_required => {
                let message = TerminalServerMessage::Error {
                    message: "终端授权已过期，请重新输入密钥".to_owned(),
                };
                if let Ok(data) = serde_json::to_string(&message) {
                    let _ = socket.send(Message::Text(data.into())).await;
                }
                break;
            }
            inbound = socket.recv() => {
                let Some(Ok(message)) = inbound else { break; };
                match message {
                    Message::Text(text) => match serde_json::from_str::<TerminalClientMessage>(&text) {
                        Ok(TerminalClientMessage::Input { data }) => session.input(data),
                        Ok(TerminalClientMessage::Resize { cols, rows }) => session.resize(rows, cols),
                        Ok(TerminalClientMessage::Close) => {
                            session.shutdown();
                            break;
                        }
                        Err(error) => {
                            let message = TerminalServerMessage::Error { message: format!("终端消息格式无效：{error}") };
                            if let Ok(data) = serde_json::to_string(&message) {
                                let _ = socket.send(Message::Text(data.into())).await;
                            }
                        }
                    },
                    Message::Binary(_) => {}
                    Message::Ping(data) => {
                        if socket.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                }
            }
        }
    }
}

async fn ensure_terminal_allowed(state: &AppState) -> Result<(), AppError> {
    if terminal_access_required(state).await {
        state.terminal_access.ensure_authorized()?;
    }
    Ok(())
}

async fn terminal_access_required(state: &AppState) -> bool {
    let config = state.config.read().await;
    state
        .runtime
        .effective_host
        .as_deref()
        .unwrap_or(&config.host)
        == "0.0.0.0"
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
    payload: Option<Json<RequirementConfirmRequest>>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    {
        let readiness = state.publication_readiness.read().await;
        ensure_publication_ready(&readiness)?;
    }
    let payload = payload.map(|Json(payload)| payload).unwrap_or_default();
    let project_id = {
        let mut store = state.store.write().await;
        store
            .confirm_requirement(&requirement_id, payload.prompt_id, payload.revision)
            .await?
    };
    spawn_project_scheduler(state.clone(), project_id.clone());
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn plan_requirement_execution(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    {
        let readiness = state.publication_readiness.read().await;
        ensure_publication_ready(&readiness)?;
    }
    let project_id = {
        let mut store = state.store.write().await;
        store.requeue_failed_planning(&requirement_id).await?
    };
    spawn_project_scheduler(state.clone(), project_id.clone());
    let store = state.store.read().await;
    Ok(Json(store.project_canvas(&project_id)?))
}

pub async fn recover_task_group(
    State(state): State<AppState>,
    AxumPath((requirement_id, task_id)): AxumPath<(String, String)>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    {
        let readiness = state.publication_readiness.read().await;
        ensure_publication_ready(&readiness)?;
    }
    let project_id = {
        let mut store = state.store.write().await;
        store.recover_task_group(&requirement_id, &task_id).await?
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

pub async fn reload_model_settings(
    State(state): State<AppState>,
) -> Result<Json<ModelSettingsResponse>, AppError> {
    ensure_runtime_idle(&state).await?;
    state.model_provider.reload().await?;
    get_model_settings(State(state)).await
}

#[derive(Debug, Serialize)]
pub struct RestartResponse {
    accepted: bool,
    next_url: String,
}

pub async fn restart_system(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    ensure_runtime_idle(&state).await?;
    let lifecycle_tx = state
        .runtime
        .lifecycle_tx
        .as_ref()
        .ok_or_else(|| AppError::conflict("当前启动模式不支持 Web 重启"))?;
    let effective_port = state
        .runtime
        .port_override
        .unwrap_or(state.config.read().await.port);
    let next_url = state
        .runtime
        .dev_frontend_url
        .clone()
        .unwrap_or_else(|| format!("http://127.0.0.1:{effective_port}"));
    lifecycle_tx
        .send(crate::api::LifecycleCommand::Restart)
        .map_err(|_| AppError::conflict("应用生命周期通道已关闭"))?;
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(RestartResponse {
            accepted: true,
            next_url,
        }),
    ))
}

pub async fn ensure_runtime_idle(state: &AppState) -> Result<(), AppError> {
    let store = state.store.read().await;
    let busy = store.data.project_chats.iter().any(|chat| chat.running)
        || store.data.requirements.iter().any(|requirement| {
            matches!(
                requirement.status,
                RequirementStatus::Analyzing
                    | RequirementStatus::Planning
                    | RequirementStatus::Queued
                    | RequirementStatus::Running
            )
        });
    if busy {
        Err(AppError::conflict(
            "存在运行中的问答、需求分析或执行任务，当前操作已阻止",
        ))
    } else {
        Ok(())
    }
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
    state
        .pending_requirement_interactions
        .lock()
        .await
        .remove(&requirement_id);
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
    state
        .pending_requirement_interactions
        .lock()
        .await
        .remove(&requirement_id);
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
        let mut internal_events = state.requirement_events.subscribe();
        let emitter = RequirementEventEmitter {
            requirement_id: requirement_id.clone(),
            task_id: None,
            bus: state.requirement_events.clone(),
        };
        emitter.emit("coordinator_started", "Coordinator 开始分析需求。");

        let analysis = state
            .model_provider
            .analyze_requirement(input, Some(emitter.clone()));
        tokio::pin!(analysis);
        let output = loop {
            tokio::select! {
                output = &mut analysis => break output,
                event = internal_events.recv() => {
                    if let Ok(event) = event
                        && event.requirement_id == requirement_id
                    {
                        handle_requirement_interaction_event(
                            &state,
                            &emitter,
                            &requirement_id,
                            event,
                        ).await;
                    }
                }
            }
        };

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

        state
            .pending_requirement_interactions
            .lock()
            .await
            .remove(&requirement_id);
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

async fn handle_requirement_interaction_event(
    state: &AppState,
    emitter: &RequirementEventEmitter,
    requirement_id: &str,
    event: RequirementEvent,
) {
    if event.event != "pi_event" {
        return;
    }
    let Some(payload) = event.payload else {
        return;
    };
    match payload.get("type").and_then(serde_json::Value::as_str) {
        Some("raccoon_session_bound") => {
            let Some(session_file) = payload
                .get("sessionFile")
                .and_then(serde_json::Value::as_str)
            else {
                return;
            };
            if let Err(error) = state
                .store
                .write()
                .await
                .bind_requirement_session(requirement_id, session_file.to_owned())
                .await
            {
                tracing::error!(requirement_id, %error, "failed to persist Pi session binding");
            }
        }
        Some("extension_ui_request")
            if payload.get("method").and_then(serde_json::Value::as_str) == Some("editor")
                && payload.get("title").and_then(serde_json::Value::as_str)
                    == Some("raccoon:clarifications:v1") =>
        {
            let Some(request_id) = payload.get("id").and_then(serde_json::Value::as_str) else {
                return;
            };
            let Some(prefill) = payload.get("prefill").and_then(serde_json::Value::as_str) else {
                return;
            };
            let clarifications = serde_json::from_str::<serde_json::Value>(prefill)
                .ok()
                .and_then(|value| value.get("questions").cloned())
                .and_then(|value| {
                    serde_json::from_value::<Vec<RequirementClarification>>(value).ok()
                });
            let Some(clarifications) = clarifications else {
                tracing::error!(requirement_id, "invalid clarification plugin payload");
                return;
            };
            let project_id = {
                let mut store = state.store.write().await;
                let project_id = store
                    .requirement_index(requirement_id)
                    .ok()
                    .map(|index| store.data.requirements[index].project_id.clone());
                if let Err(error) = store
                    .apply_requirement_clarification_request(requirement_id, clarifications)
                    .await
                {
                    tracing::error!(requirement_id, %error, "failed to persist clarifications");
                    return;
                }
                project_id
            };
            let Some(project_id) = project_id else {
                return;
            };
            state.pending_requirement_interactions.lock().await.insert(
                requirement_id.to_owned(),
                (project_id, request_id.to_owned()),
            );
            emitter.emit("clarifications_ready", "新的澄清问题已生成。");
        }
        _ => {}
    }
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

pub fn spawn_startup_requirement_scheduler(state: AppState) {
    tokio::spawn(async move {
        {
            let readiness = state.publication_readiness.read().await;
            if !readiness.ready {
                tracing::warn!(
                    issues = %readiness.issues.join("；"),
                    "publication prerequisites failed; startup requirement recovery is blocked"
                );
                return;
            }
        }
        let project_ids = {
            let mut pending = state.pending_startup_requirement_ids.lock().await;
            std::mem::take(&mut *pending)
        };
        for project_id in project_ids {
            spawn_project_scheduler(state.clone(), project_id);
        }
    });
}

fn ensure_publication_ready(
    readiness: &crate::models::PublicationReadiness,
) -> Result<(), AppError> {
    if readiness.ready {
        return Ok(());
    }
    Err(AppError::conflict(format!(
        "{} {}",
        readiness.summary,
        readiness.issues.join("；")
    )))
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

        match running_tasks.join_next().await {
            Some(Ok(
                TaskExecutionDisposition::Continue | TaskExecutionDisposition::FinalFailure,
            )) => {}
            Some(Err(error)) => {
                tracing::error!(requirement_id, %error, "task execution join failed");
            }
            None => {}
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
                        emitter.emit(
                            "execution_task_failed",
                            &format!("保存任务结果失败：{error}"),
                        );
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
                emitter.emit("execution_task_failed", "任务执行失败。");
            }
            disposition
        });
    }
}

#[cfg(test)]
mod event_filter_tests {
    use super::*;

    fn event(event: &str, task_id: Option<&str>) -> RequirementEvent {
        RequirementEvent {
            requirement_id: "requirement-1".to_owned(),
            task_id: task_id.map(str::to_owned),
            event: event.to_owned(),
            message: "event".to_owned(),
            pi_type: None,
            payload: None,
        }
    }

    #[test]
    fn summary_stream_drops_pi_events() {
        let query = RequirementEventsQuery {
            include_pi_events: false,
        };
        assert!(!requirement_event_matches(
            &event("pi_event", Some("task-1")),
            "requirement-1",
            &query,
        ));
        assert!(requirement_event_matches(
            &event("execution_task_started", Some("task-1")),
            "requirement-1",
            &query,
        ));
    }

    #[test]
    fn failed_publication_readiness_blocks_execution() {
        let readiness = crate::models::PublicationReadiness {
            mode: "pull_request".to_owned(),
            provider: crate::models::GitProvider::GitHub,
            ready: false,
            summary: "前置检查未通过".to_owned(),
            issues: vec!["gh 未登录".to_owned()],
            notes: Vec::new(),
        };

        let error = ensure_publication_ready(&readiness).unwrap_err();
        assert!(matches!(error, AppError::Conflict(_)));
        assert!(error.to_string().contains("gh 未登录"));
    }
}
