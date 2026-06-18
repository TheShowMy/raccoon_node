use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    future::Future,
    io::ErrorKind,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{broadcast, Mutex},
};
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
struct AppState {
    store: Arc<Mutex<JsonStore>>,
    model_provider: Arc<dyn ModelProvider>,
    requirement_events: RequirementEventBus,
}

static PI_RPC_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
struct RequirementEventBus {
    tx: broadcast::Sender<RequirementEvent>,
}

#[derive(Debug, Clone, Serialize)]
struct RequirementEvent {
    requirement_id: String,
    event: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pi_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
}

#[derive(Debug, Clone)]
struct RequirementEventEmitter {
    requirement_id: String,
    bus: RequirementEventBus,
}

struct JsonStore {
    path: PathBuf,
    data_root: PathBuf,
    data: AppData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct AppData {
    projects: Vec<Project>,
    #[serde(default)]
    requirements: Vec<Requirement>,
    settings_summary: SummaryNode,
    model_summary: SummaryNode,
    #[serde(default)]
    model_settings: ModelSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Project {
    id: String,
    name: String,
    git_url: String,
    local_path: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Requirement {
    id: String,
    project_id: String,
    title: String,
    original_message: String,
    status: RequirementStatus,
    messages: Vec<RequirementMessage>,
    #[serde(default)]
    clarification_round: u32,
    #[serde(default)]
    clarifications: Vec<RequirementClarification>,
    draft: Option<RequirementDraft>,
    pi_session_file: Option<String>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RequirementStatus {
    Analyzing,
    Clarifying,
    DraftReady,
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct RequirementMessage {
    role: RequirementMessageRole,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RequirementMessageRole {
    User,
    Assistant,
    System,
    Trace,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct RequirementDraft {
    title: String,
    summary: String,
    acceptance_criteria: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct RequirementClarification {
    id: String,
    question: String,
    question_type: ClarificationQuestionType,
    options: Vec<ClarificationOption>,
    answer: Option<ClarificationAnswer>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ClarificationQuestionType {
    SingleChoice,
    MultiChoice,
    FreeText,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct ClarificationOption {
    value: String,
    label: String,
    description: String,
    #[serde(default)]
    recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct ClarificationAnswer {
    selected_options: Vec<String>,
    custom_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectCanvasResponse {
    project: Project,
    active_requirement: Option<Requirement>,
    queued_requirements: Vec<Requirement>,
    completed_requirements: Vec<Requirement>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct SummaryNode {
    title: String,
    description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct ModelSettings {
    low: ModelTierSetting,
    medium: ModelTierSetting,
    high: ModelTierSetting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct ModelTierSetting {
    model_id: Option<String>,
    thinking_level: ThinkingLevel,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct PiModel {
    id: String,
    name: String,
    provider: String,
    #[serde(default)]
    reasoning: bool,
}

#[derive(Debug, Serialize)]
struct ModelSettingsResponse {
    models: Vec<PiModel>,
    settings: ModelSettings,
    rpc_status: RpcStatus,
    rpc_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum RpcStatus {
    Ready,
    Error,
}

type ModelProviderFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<PiModel>, AppError>> + Send + 'a>>;
type RequirementAnalysisFuture<'a> =
    Pin<Box<dyn Future<Output = Result<RequirementAnalysisOutput, AppError>> + Send + 'a>>;

trait ModelProvider: Send + Sync {
    fn available_models(&self) -> ModelProviderFuture<'_>;
    fn analyze_requirement(
        &self,
        input: RequirementAnalysisInput,
        events: Option<RequirementEventEmitter>,
    ) -> RequirementAnalysisFuture<'_>;
}

#[derive(Debug, Clone)]
struct RequirementAnalysisInput {
    project: Project,
    messages: Vec<RequirementMessage>,
    clarifications: Vec<RequirementClarification>,
    draft: Option<RequirementDraft>,
    model_settings: ModelSettings,
    pi_session_file: Option<String>,
}

#[derive(Debug, Clone)]
struct RequirementAnalysisOutput {
    status: RequirementStatus,
    assistant_message: String,
    progress: String,
    clarifications: Vec<RequirementClarification>,
    draft: Option<RequirementDraft>,
    pi_session_file: Option<String>,
    error: Option<String>,
    trace: Option<Value>,
}

struct PiRpcModelProvider {
    client: Option<Arc<PiRpcClient>>,
    startup_error: Option<String>,
}

struct PiRpcClient {
    io_lock: Mutex<()>,
    stdin: Mutex<ChildStdin>,
    stdout: Mutex<BufReader<ChildStdout>>,
    child: Mutex<Child>,
}

#[derive(Debug, Deserialize)]
struct CreateProjectRequest {
    name: String,
    git_url: String,
}

#[derive(Debug, Deserialize)]
struct RequirementMessageRequest {
    message: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ClarificationAnswerRequest {
    clarification_id: String,
    selected_options: Vec<String>,
    custom_text: Option<String>,
}

#[derive(Debug, Serialize)]
struct ApiError {
    message: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "raccoon_node=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let data_path = data_file_path();
    let public_dir = public_dir_path();
    let app = build_app(data_path, public_dir).await;
    let addr = server_addr();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind server address");

    tracing::info!("server listening on http://{addr}");
    axum::serve(listener, app).await.expect("server failed");
}

async fn build_app(data_path: PathBuf, public_dir: PathBuf) -> Router {
    let store = JsonStore::open(data_path)
        .await
        .expect("failed to initialize json store");
    let model_provider = PiRpcModelProvider::start(store.data_root.clone()).await;
    build_app_with_model_provider(store, public_dir, Arc::new(model_provider))
}

fn build_app_with_model_provider(
    store: JsonStore,
    public_dir: PathBuf,
    model_provider: Arc<dyn ModelProvider>,
) -> Router {
    let (event_tx, _) = broadcast::channel(256);
    let state = AppState {
        store: Arc::new(Mutex::new(store)),
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

    Router::new()
        .nest("/api", api)
        .fallback_service(static_files)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
}

async fn get_start(State(state): State<AppState>) -> Json<AppData> {
    let store = state.store.lock().await;
    Json(store.data.clone())
}

async fn create_project(
    State(state): State<AppState>,
    Json(payload): Json<CreateProjectRequest>,
) -> Result<Json<Project>, AppError> {
    let mut store = state.store.lock().await;
    let project = store.create_project(payload.name, payload.git_url).await?;
    Ok(Json(project))
}

async fn delete_project(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    let mut store = state.store.lock().await;
    store.delete_project(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_project_canvas(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let store = state.store.lock().await;
    Ok(Json(store.project_canvas(&id)?))
}

async fn create_requirement(
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

async fn append_requirement_message(
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

async fn submit_requirement_clarifications(
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

async fn requirement_events(
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

async fn confirm_requirement(
    State(state): State<AppState>,
    AxumPath(requirement_id): AxumPath<String>,
) -> Result<Json<ProjectCanvasResponse>, AppError> {
    let mut store = state.store.lock().await;
    let project_id = store.confirm_requirement(&requirement_id).await?;
    Ok(Json(store.project_canvas(&project_id)?))
}

async fn get_model_settings(
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

async fn put_model_settings(
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

impl RequirementEventEmitter {
    fn emit(&self, event: &str, message: &str) {
        let _ = self.bus.tx.send(RequirementEvent {
            requirement_id: self.requirement_id.clone(),
            event: event.to_owned(),
            message: message.to_owned(),
            pi_type: None,
            payload: None,
        });
    }

    fn emit_pi_event(&self, payload: Value) {
        let pi_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let message = summarize_pi_event(&pi_type, &payload);
        let _ = self.bus.tx.send(RequirementEvent {
            requirement_id: self.requirement_id.clone(),
            event: "pi_event".to_owned(),
            message,
            pi_type: Some(pi_type),
            payload: Some(payload),
        });
    }
}

impl JsonStore {
    async fn open(path: PathBuf) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        if !path.exists() {
            let data = AppData::default();
            write_json(&path, &data).await?;
            let data_root = data_root_from_file(&path)?;
            return Ok(Self {
                path,
                data_root,
                data,
            });
        }

        let content = tokio::fs::read_to_string(&path).await?;
        let data = serde_json::from_str(&content)?;
        let data_root = data_root_from_file(&path)?;
        Ok(Self {
            path,
            data_root,
            data,
        })
    }

    async fn create_project(
        &mut self,
        raw_name: String,
        raw_git_url: String,
    ) -> Result<Project, AppError> {
        let name = raw_name.trim();
        if name.is_empty() {
            return Err(AppError::bad_request("项目名称不能为空"));
        }

        let git_url = raw_git_url.trim();
        if git_url.is_empty() {
            return Err(AppError::bad_request("Git 链接不能为空"));
        }
        if git_url.contains('\0') {
            return Err(AppError::bad_request("Git 链接包含非法字符"));
        }

        if name
            .chars()
            .any(|ch| matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            return Err(AppError::bad_request("项目名称不能包含文件路径非法字符"));
        }

        if self
            .data
            .projects
            .iter()
            .any(|project| project.name.eq_ignore_ascii_case(name))
        {
            return Err(AppError::bad_request("项目名称已存在"));
        }

        let now = Utc::now();
        let id = format!("{}-{}", slugify(name), now.timestamp_millis());
        let project_dir = self.project_dir(&id)?;
        let repo_dir = project_dir.join("repo");
        if repo_dir.exists() {
            return Err(AppError::bad_request("项目本地目录已存在"));
        }

        tokio::fs::create_dir_all(&project_dir).await?;
        if let Err(error) = clone_git_repo(git_url, &repo_dir).await {
            remove_dir_if_exists(&project_dir).await?;
            return Err(error);
        }

        let project = Project {
            id: id.clone(),
            name: name.to_owned(),
            git_url: git_url.to_owned(),
            local_path: display_path(&repo_dir),
            created_at: now,
            updated_at: now,
        };

        self.data.projects.push(project.clone());
        write_json(&self.path, &self.data).await?;
        Ok(project)
    }

    async fn delete_project(&mut self, id: &str) -> Result<(), AppError> {
        let index = self
            .data
            .projects
            .iter()
            .position(|project| project.id == id)
            .ok_or_else(|| AppError::not_found("项目不存在"))?;

        let project_dir = self.project_dir(id)?;
        if project_dir.exists() {
            remove_dir_if_exists(&project_dir).await?;
        }

        self.data.projects.remove(index);
        self.data
            .requirements
            .retain(|requirement| requirement.project_id != id);
        write_json(&self.path, &self.data).await?;
        Ok(())
    }

    async fn save_model_settings(
        &mut self,
        settings: ModelSettings,
        models: &[PiModel],
    ) -> Result<(), AppError> {
        validate_model_settings(&settings, models)?;
        self.data.model_settings = settings;
        self.data.model_summary.description = model_summary_description(&self.data.model_settings);
        write_json(&self.path, &self.data).await?;
        Ok(())
    }

    fn project_canvas(&self, project_id: &str) -> Result<ProjectCanvasResponse, AppError> {
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;

        let mut active = self
            .data
            .requirements
            .iter()
            .filter(|requirement| {
                requirement.project_id == project_id
                    && matches!(
                        requirement.status,
                        RequirementStatus::Analyzing
                            | RequirementStatus::Clarifying
                            | RequirementStatus::DraftReady
                            | RequirementStatus::Failed
                    )
            })
            .cloned()
            .collect::<Vec<_>>();
        sort_requirements_desc(&mut active);

        let mut queued_requirements = self
            .data
            .requirements
            .iter()
            .filter(|requirement| {
                requirement.project_id == project_id
                    && matches!(
                        requirement.status,
                        RequirementStatus::Queued | RequirementStatus::Running
                    )
            })
            .cloned()
            .collect::<Vec<_>>();
        sort_requirements_desc(&mut queued_requirements);

        let mut completed_requirements = self
            .data
            .requirements
            .iter()
            .filter(|requirement| {
                requirement.project_id == project_id
                    && requirement.status == RequirementStatus::Completed
            })
            .cloned()
            .collect::<Vec<_>>();
        sort_requirements_desc(&mut completed_requirements);

        Ok(ProjectCanvasResponse {
            project,
            active_requirement: active.into_iter().next(),
            queued_requirements,
            completed_requirements,
        })
    }

    async fn create_requirement(
        &mut self,
        project_id: &str,
        message: String,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;

        let now = Utc::now();
        let id = format!("requirement-{}", now.timestamp_millis());
        let requirement = Requirement {
            id: id.clone(),
            project_id: project_id.to_owned(),
            title: derive_requirement_title(&message),
            original_message: message.clone(),
            status: RequirementStatus::Analyzing,
            messages: vec![RequirementMessage {
                role: RequirementMessageRole::User,
                content: message,
                metadata: None,
                created_at: now,
            }],
            clarification_round: 0,
            clarifications: Vec::new(),
            draft: None,
            pi_session_file: None,
            error: None,
            created_at: now,
            updated_at: now,
        };

        let input = RequirementAnalysisInput {
            project,
            messages: requirement.messages.clone(),
            clarifications: requirement.clarifications.clone(),
            draft: None,
            model_settings: self.data.model_settings.clone(),
            pi_session_file: None,
        };
        self.data.requirements.push(requirement);
        write_json(&self.path, &self.data).await?;
        Ok((id, input))
    }

    async fn append_requirement_message(
        &mut self,
        requirement_id: &str,
        message: String,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        let index = self.requirement_index(requirement_id)?;
        if !matches!(
            self.data.requirements[index].status,
            RequirementStatus::Clarifying
                | RequirementStatus::Analyzing
                | RequirementStatus::Failed
                | RequirementStatus::DraftReady
        ) {
            return Err(AppError::bad_request("当前需求状态不允许继续补充"));
        }

        let project_id = self.data.requirements[index].project_id.clone();
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;
        let now = Utc::now();
        {
            let requirement = &mut self.data.requirements[index];
            requirement.status = RequirementStatus::Analyzing;
            requirement.error = None;
            requirement.clarifications.clear();
            requirement.updated_at = now;
            requirement.messages.push(RequirementMessage {
                role: RequirementMessageRole::User,
                content: message,
                metadata: None,
                created_at: now,
            });
        }

        let requirement = self.data.requirements[index].clone();
        write_json(&self.path, &self.data).await?;
        Ok((
            project_id,
            RequirementAnalysisInput {
                project,
                messages: requirement.messages,
                clarifications: requirement.clarifications,
                draft: requirement.draft,
                model_settings: self.data.model_settings.clone(),
                pi_session_file: requirement.pi_session_file,
            },
        ))
    }

    async fn submit_requirement_clarifications(
        &mut self,
        requirement_id: &str,
        answers: Vec<ClarificationAnswerRequest>,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        if answers.is_empty() {
            return Err(AppError::bad_request("请先回答澄清问题"));
        }

        let index = self.requirement_index(requirement_id)?;
        if self.data.requirements[index].status != RequirementStatus::Clarifying {
            return Err(AppError::bad_request("当前需求不在澄清状态"));
        }

        let project_id = self.data.requirements[index].project_id.clone();
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;

        let mut clarifications = self.data.requirements[index].clarifications.clone();
        for request in answers {
            let clarification = clarifications
                .iter_mut()
                .find(|item| item.id == request.clarification_id)
                .ok_or_else(|| AppError::bad_request("澄清项不存在"))?;
            let answer = ClarificationAnswer {
                selected_options: request.selected_options,
                custom_text: request.custom_text.filter(|text| !text.trim().is_empty()),
            };
            if !clarification_has_answer(clarification, &answer) {
                return Err(AppError::bad_request("澄清答案不能为空"));
            }
            clarification.answer = Some(answer);
        }

        if clarifications
            .iter()
            .any(|clarification| clarification.answer.is_none())
        {
            return Err(AppError::bad_request("请完成全部澄清问题"));
        }

        let summary = build_clarification_answer_summary(&clarifications);
        let now = Utc::now();
        {
            let requirement = &mut self.data.requirements[index];
            requirement.status = RequirementStatus::Analyzing;
            requirement.error = None;
            requirement.clarifications = clarifications;
            requirement.updated_at = now;
            requirement.messages.push(RequirementMessage {
                role: RequirementMessageRole::User,
                content: summary,
                metadata: None,
                created_at: now,
            });
        }

        let requirement = self.data.requirements[index].clone();
        write_json(&self.path, &self.data).await?;
        Ok((
            project_id,
            RequirementAnalysisInput {
                project,
                messages: requirement.messages,
                clarifications: requirement.clarifications,
                draft: requirement.draft,
                model_settings: self.data.model_settings.clone(),
                pi_session_file: requirement.pi_session_file,
            },
        ))
    }

    async fn apply_requirement_analysis(
        &mut self,
        requirement_id: &str,
        output: Result<RequirementAnalysisOutput, AppError>,
    ) -> Result<(), AppError> {
        let index = self.requirement_index(requirement_id)?;
        let now = Utc::now();
        let requirement = &mut self.data.requirements[index];
        match output {
            Ok(output) => {
                requirement.status = output.status;
                requirement.draft = output.draft;
                requirement.pi_session_file = output.pi_session_file;
                requirement.error = output.error;
                requirement.updated_at = now;
                if !output.clarifications.is_empty() {
                    requirement.clarification_round =
                        requirement.clarification_round.saturating_add(1);
                    requirement.clarifications = output.clarifications;
                } else if output.status == RequirementStatus::DraftReady {
                    requirement.clarifications.clear();
                }
                if !output.assistant_message.trim().is_empty() {
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::Assistant,
                        content: output.assistant_message,
                        metadata: None,
                        created_at: now,
                    });
                }
                if let Some(trace) = output.trace {
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::Trace,
                        content: "Pi Agent 分析过程".to_owned(),
                        metadata: Some(trace),
                        created_at: now,
                    });
                }
            }
            Err(error) => {
                requirement.status = RequirementStatus::Failed;
                requirement.error = Some(error.to_string());
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::System,
                    content: format!("需求分析失败：{error}"),
                    metadata: None,
                    created_at: now,
                });
            }
        }
        write_json(&self.path, &self.data).await?;
        Ok(())
    }

    async fn confirm_requirement(&mut self, requirement_id: &str) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        if self.data.requirements[index].status != RequirementStatus::DraftReady {
            return Err(AppError::bad_request("只有已生成确认卡片的需求才能确认"));
        }
        let now = Utc::now();
        let project_id = self.data.requirements[index].project_id.clone();
        self.data.requirements[index].status = RequirementStatus::Queued;
        self.data.requirements[index].updated_at = now;
        write_json(&self.path, &self.data).await?;
        Ok(project_id)
    }

    fn requirement_index(&self, requirement_id: &str) -> Result<usize, AppError> {
        self.data
            .requirements
            .iter()
            .position(|requirement| requirement.id == requirement_id)
            .ok_or_else(|| AppError::not_found("需求不存在"))
    }

    fn project_dir(&self, id: &str) -> Result<PathBuf, AppError> {
        if id.is_empty()
            || id
                .chars()
                .any(|ch| !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
        {
            return Err(AppError::bad_request("项目 ID 非法"));
        }

        let projects_root = self.data_root.join("projects");
        let project_dir = projects_root.join(id);
        ensure_child_path(&self.data_root, &project_dir)?;
        Ok(project_dir)
    }
}

impl Default for AppData {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            requirements: Vec::new(),
            settings_summary: SummaryNode {
                title: "设置".to_owned(),
                description: "基础设置待配置".to_owned(),
            },
            model_summary: SummaryNode {
                title: "模型设置".to_owned(),
                description: "默认模型待配置".to_owned(),
            },
            model_settings: ModelSettings::default(),
        }
    }
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            low: ModelTierSetting::default_with_level(ThinkingLevel::Low),
            medium: ModelTierSetting::default_with_level(ThinkingLevel::Medium),
            high: ModelTierSetting::default_with_level(ThinkingLevel::High),
        }
    }
}

impl ModelTierSetting {
    fn default_with_level(thinking_level: ThinkingLevel) -> Self {
        Self {
            model_id: None,
            thinking_level,
        }
    }
}

impl ThinkingLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RequirementAnalysisStatus {
    NeedsClarification,
    Ready,
}

#[derive(Debug, Deserialize)]
struct RawRequirementAnalysisJson {
    status: RequirementAnalysisStatus,
    #[serde(default)]
    message: String,
    #[serde(default)]
    progress: String,
    #[serde(default)]
    clarifications: Vec<RawRequirementClarification>,
    draft: Option<RequirementDraft>,
}

#[derive(Debug, Deserialize)]
struct RawRequirementClarification {
    id: Option<String>,
    question: String,
    #[serde(alias = "questionType", alias = "type")]
    question_type: Option<ClarificationQuestionType>,
    #[serde(default)]
    options: Vec<RawClarificationOption>,
}

#[derive(Debug, Deserialize)]
struct RawClarificationOption {
    value: Option<String>,
    label: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    recommended: bool,
}

fn build_requirement_prompt(input: &RequirementAnalysisInput) -> String {
    let mut history = String::new();
    for message in &input.messages {
        let role = match message.role {
            RequirementMessageRole::User => "用户",
            RequirementMessageRole::Assistant => "Coordinator",
            RequirementMessageRole::System => "系统",
            RequirementMessageRole::Trace => "过程记录",
        };
        if message.role == RequirementMessageRole::Trace {
            continue;
        }
        history.push_str(&format!("{role}: {}\n", message.content));
    }

    let clarifications = if input.clarifications.is_empty() {
        "当前没有待澄清项。\n".to_owned()
    } else {
        let mut lines = String::new();
        for item in &input.clarifications {
            lines.push_str(&format!("- {}：{}\n", item.id, item.question));
            if let Some(answer) = &item.answer {
                lines.push_str(&format!(
                    "  用户回答：{}\n",
                    format_clarification_answer(item, answer)
                ));
            }
        }
        lines
    };

    let existing_draft = input
        .draft
        .as_ref()
        .map(|draft| {
            format!(
                "当前确认草案：{}\n{}\n验收标准：{}\n",
                draft.title,
                draft.summary,
                draft.acceptance_criteria.join("；")
            )
        })
        .unwrap_or_else(|| "当前还没有确认草案。\n".to_owned());

    format!(
        r#"你是 raccoon_node 的需求澄清 Coordinator。
只处理需求澄清和确认，不要拆分任务，不要生成 DAG，不要执行代码。
所有可展示内容必须使用简体中文。

判断当前需求是否足够进入执行队列：
- 如果还缺少会影响实现路径、验收标准、数据兼容或安全边界的信息，返回 needs_clarification。
- 如果已经足够明确，返回 ready，并给出确认需求草案。

你必须只输出一个 JSON 对象，不要 Markdown，不要代码块。
JSON 格式：
{{
  "status": "needs_clarification",
  "progress": "你已经完成了哪些判断，以及为什么需要继续澄清",
  "message": "需要向用户确认的问题或说明",
  "clarifications": [
    {{
      "id": "q1",
      "question": "澄清问题",
      "question_type": "single_choice",
      "options": [
        {{
          "value": "option-a",
          "label": "选项标题",
          "description": "选择后的影响或取舍",
          "recommended": true
        }}
      ],
      "answer": null
    }}
  ],
  "draft": null
}}
或：
{{
  "status": "ready",
  "progress": "需求已经足够清晰的依据",
  "message": "需求已经足够清晰，我已整理确认卡片。",
  "clarifications": [],
  "draft": {{
    "title": "确认需求标题",
    "summary": "最终需求范围摘要",
    "acceptance_criteria": ["验收标准 1", "验收标准 2"]
  }}
}}

澄清问题要求：
- question_type 只能是 single_choice、multi_choice、free_text。
- single_choice 和 multi_choice 必须提供 2-4 个有意义选项。
- free_text 的 options 使用空数组。
- clarifications 最多 6 个。

## 项目上下文
项目名：{}
Git：{}
本地路径：{}

## 已有草案
{}
## 待澄清项与用户答案
{}
## 对话历史
{}"#,
        input.project.name,
        input.project.git_url,
        input.project.local_path,
        existing_draft,
        clarifications,
        history
    )
}

fn parse_requirement_analysis(
    assistant_text: &str,
    pi_session_file: Option<String>,
    trace: Option<Value>,
) -> RequirementAnalysisOutput {
    let Some(json_text) = extract_json_object(assistant_text) else {
        let message = if looks_like_html(assistant_text) {
            "Pi Agent 返回了 HTML 内容，未能提取结构化澄清结果。".to_owned()
        } else {
            assistant_text.to_owned()
        };
        return RequirementAnalysisOutput {
            status: RequirementStatus::Failed,
            assistant_message: message,
            progress: String::new(),
            clarifications: Vec::new(),
            draft: None,
            pi_session_file,
            error: Some("Pi Agent 未返回结构化 JSON".to_owned()),
            trace,
        };
    };

    match serde_json::from_str::<RawRequirementAnalysisJson>(&json_text) {
        Ok(parsed) => match parsed.status {
            RequirementAnalysisStatus::NeedsClarification => {
                let progress = if parsed.progress.trim().is_empty() {
                    parsed.message.clone()
                } else {
                    parsed.progress
                };
                let clarifications = normalize_requirement_clarifications(parsed.clarifications);
                RequirementAnalysisOutput {
                    status: RequirementStatus::Clarifying,
                    assistant_message: parsed.message,
                    progress,
                    clarifications,
                    draft: None,
                    pi_session_file,
                    error: None,
                    trace,
                }
            }
            RequirementAnalysisStatus::Ready => {
                let Some(draft) = parsed.draft else {
                    return RequirementAnalysisOutput {
                        status: RequirementStatus::Failed,
                        assistant_message: parsed.message,
                        progress: parsed.progress,
                        clarifications: Vec::new(),
                        draft: None,
                        pi_session_file,
                        error: Some("ready 状态缺少确认需求草案".to_owned()),
                        trace,
                    };
                };
                RequirementAnalysisOutput {
                    status: RequirementStatus::DraftReady,
                    assistant_message: parsed.message,
                    progress: parsed.progress,
                    clarifications: Vec::new(),
                    draft: Some(draft),
                    pi_session_file,
                    error: None,
                    trace,
                }
            }
        },
        Err(error) => RequirementAnalysisOutput {
            status: RequirementStatus::Failed,
            assistant_message: if looks_like_html(assistant_text) {
                "Pi Agent 返回了 HTML 内容，解析结构化澄清结果失败。".to_owned()
            } else {
                assistant_text.to_owned()
            },
            progress: String::new(),
            clarifications: Vec::new(),
            draft: None,
            pi_session_file,
            error: Some(format!("解析 Pi Agent JSON 失败：{error}")),
            trace,
        },
    }
}

fn extract_json_object(value: &str) -> Option<String> {
    let trimmed = value.trim();

    if let Some(json) = extract_markdown_json(trimmed) {
        return Some(json);
    }

    let (start, end) = find_balanced_braces(trimmed)?;
    Some(sanitize_json_fragment(trimmed[start..=end].trim()))
}

fn extract_markdown_json(text: &str) -> Option<String> {
    for marker in ["```json\n", "```json ", "```\n", "``` "] {
        if let Some(start) = text.find(marker) {
            let after_marker = &text[start + marker.len()..];
            if let Some(end) = after_marker.find("```") {
                let content = after_marker[..end].trim();
                if content.starts_with('{') {
                    return Some(content.to_owned());
                }
            }
        }
    }
    None
}

fn find_balanced_braces(text: &str) -> Option<(usize, usize)> {
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape_next = false;

    for (index, ch) in text.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }

        match ch {
            '\\' if in_string => escape_next = true,
            '"' => in_string = !in_string,
            '{' if !in_string => {
                if start.is_none() {
                    start = Some(index);
                }
                depth += 1;
            }
            '}' if !in_string => {
                if depth > 0 {
                    depth -= 1;
                    if depth == 0 {
                        return start.map(|start| (start, index));
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn sanitize_json_fragment(text: &str) -> String {
    text.replace(",\n}", "\n}")
        .replace(",\n]", "\n]")
        .replace(",}", "}")
        .replace(",]", "]")
}

fn looks_like_html(text: &str) -> bool {
    let trimmed = text.trim_start().to_ascii_lowercase();
    trimmed.starts_with("<!doctype") || trimmed.starts_with("<html")
}

fn normalize_requirement_clarifications(
    items: Vec<RawRequirementClarification>,
) -> Vec<RequirementClarification> {
    items
        .into_iter()
        .take(6)
        .enumerate()
        .filter_map(|(index, item)| {
            let question = item.question.trim().to_owned();
            if question.is_empty() {
                return None;
            }

            let question_type = item
                .question_type
                .unwrap_or(ClarificationQuestionType::FreeText);
            let options = if question_type == ClarificationQuestionType::FreeText {
                Vec::new()
            } else {
                normalize_clarification_options(item.options)
            };

            Some(RequirementClarification {
                id: item.id.unwrap_or_else(|| format!("q{}", index + 1)),
                question,
                question_type,
                options,
                answer: None,
            })
        })
        .collect()
}

fn normalize_clarification_options(items: Vec<RawClarificationOption>) -> Vec<ClarificationOption> {
    let mut options = items
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let label = item.label.trim().to_owned();
            if label.is_empty() {
                return None;
            }
            let value = item
                .value
                .unwrap_or_else(|| format!("option-{}", index + 1));
            Some(ClarificationOption {
                value,
                label,
                description: item.description.trim().to_owned(),
                recommended: item.recommended,
            })
        })
        .collect::<Vec<_>>();

    if options.len() > 4 {
        options.sort_by(|left, right| right.recommended.cmp(&left.recommended));
        options.truncate(4);
    }
    options
}

fn clarification_has_answer(
    clarification: &RequirementClarification,
    answer: &ClarificationAnswer,
) -> bool {
    match clarification.question_type {
        ClarificationQuestionType::FreeText => answer
            .custom_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty()),
        ClarificationQuestionType::SingleChoice | ClarificationQuestionType::MultiChoice => {
            !answer.selected_options.is_empty()
                || answer
                    .custom_text
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty())
        }
    }
}

fn build_clarification_answer_summary(clarifications: &[RequirementClarification]) -> String {
    let mut lines = vec!["已提交澄清答案：".to_owned()];
    for item in clarifications {
        if let Some(answer) = &item.answer {
            lines.push(format!(
                "- {}：{}",
                item.question,
                format_clarification_answer(item, answer)
            ));
        }
    }
    lines.join("\n")
}

fn format_clarification_answer(
    item: &RequirementClarification,
    answer: &ClarificationAnswer,
) -> String {
    let mut parts = Vec::new();
    for selected in &answer.selected_options {
        let label = item
            .options
            .iter()
            .find(|option| option.value == *selected)
            .map(|option| option.label.as_str())
            .unwrap_or(selected);
        parts.push(label.to_owned());
    }
    if let Some(custom_text) = answer.custom_text.as_deref() {
        if !custom_text.trim().is_empty() {
            parts.push(custom_text.trim().to_owned());
        }
    }
    if parts.is_empty() {
        "未填写".to_owned()
    } else {
        parts.join("；")
    }
}

fn build_pi_trace_metadata(events: &[Value]) -> Option<Value> {
    if events.is_empty() {
        return None;
    }

    let mut thinking = String::new();
    // output remains empty: text_delta is parsed into the assistant message,
    // so the raw structured JSON is not duplicated in the trace.
    let output = String::new();
    let mut statuses = Vec::new();
    let mut tools = Vec::new();

    for event in events {
        let pi_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match pi_type {
            "message_update" => collect_message_update(event, &mut thinking),
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                upsert_trace_tool(&mut tools, event, pi_type)
            }
            "agent_start" | "agent_end" | "turn_start" | "turn_end" | "auto_retry_start"
            | "auto_retry_end" | "compaction_start" | "compaction_end" | "extension_error" => {
                statuses.push(json!({
                    "type": pi_type,
                    "message": summarize_pi_event(pi_type, event),
                }));
            }
            _ => {}
        }
    }

    Some(json!({
        "type": "pi_trace",
        "version": 1,
        "trace": {
            "thinking": thinking,
            "output": output,
            "tools": tools,
            "statuses": statuses,
            "completed": true,
            "live": false,
        }
    }))
}

fn collect_message_update(event: &Value, thinking: &mut String) {
    let assistant_event = match event.get("assistantMessageEvent") {
        Some(Value::Object(_)) => &event["assistantMessageEvent"],
        _ => return,
    };
    let delta_type = assistant_event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let delta = assistant_event
        .get("delta")
        .or_else(|| assistant_event.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if delta_type == "thinking_delta" {
        thinking.push_str(delta);
    }
    // text_delta contains the structured JSON response; it is parsed into the
    // assistant message and should not be duplicated in the trace output.
}

fn upsert_trace_tool(tools: &mut Vec<Value>, event: &Value, pi_type: &str) {
    let tool_call_id = event
        .get("toolCallId")
        .or_else(|| event.get("tool_call_id"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let existing_index = tools.iter().position(|tool| {
        tool.get("toolCallId")
            .and_then(Value::as_str)
            .is_some_and(|id| id == tool_call_id)
    });
    let tool_name = event
        .get("toolName")
        .or_else(|| event.get("tool_name"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let status = match pi_type {
        "tool_execution_start" | "tool_execution_update" => "running",
        "tool_execution_end" => "done",
        _ => "unknown",
    };
    let is_error = event
        .get("isError")
        .or_else(|| event.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut tool = existing_index
        .and_then(|index| tools.get(index).cloned())
        .unwrap_or_else(|| {
            json!({
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "status": status,
                "output": "",
                "isError": false,
            })
        });

    tool["toolName"] = json!(tool_name);
    tool["status"] = json!(if is_error { "error" } else { status });
    tool["isError"] = json!(is_error);
    if let Some(output) = extract_tool_text(event) {
        tool["output"] = json!(output);
    }

    if let Some(index) = existing_index {
        tools[index] = tool;
    } else {
        tools.push(tool);
    }
}

fn extract_tool_text(event: &Value) -> Option<String> {
    let result = event
        .get("partialResult")
        .or_else(|| event.get("partial_result"))
        .or_else(|| event.get("result"))?;
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
}

fn summarize_pi_event(pi_type: &str, payload: &Value) -> String {
    match pi_type {
        "agent_start" => "Pi Agent 开始处理。".to_owned(),
        "agent_end" => "Pi Agent 处理完成。".to_owned(),
        "turn_start" => "开始新一轮推理。".to_owned(),
        "turn_end" => "本轮推理完成。".to_owned(),
        "message_start" => "开始生成消息。".to_owned(),
        "message_update" => "正在生成内容。".to_owned(),
        "message_end" => "消息生成完成。".to_owned(),
        "tool_execution_start" => format!(
            "开始调用工具：{}",
            payload
                .get("toolName")
                .or_else(|| payload.get("tool_name"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
        ),
        "tool_execution_update" => "工具执行中。".to_owned(),
        "tool_execution_end" => "工具执行完成。".to_owned(),
        "extension_error" => "扩展执行出错。".to_owned(),
        _ => format!("Pi Agent 事件：{pi_type}"),
    }
}

impl PiRpcModelProvider {
    async fn start(data_root: PathBuf) -> Self {
        let session_dir = data_root.join("pi-sessions");
        match PiRpcClient::start(&session_dir).await {
            Ok(client) => Self {
                client: Some(Arc::new(client)),
                startup_error: None,
            },
            Err(error) => Self {
                client: None,
                startup_error: Some(error.to_string()),
            },
        }
    }
}

impl ModelProvider for PiRpcModelProvider {
    fn available_models(&self) -> ModelProviderFuture<'_> {
        Box::pin(async move {
            match &self.client {
                Some(client) => client.get_available_models().await,
                None => Err(AppError::internal(
                    self.startup_error
                        .clone()
                        .unwrap_or_else(|| "Pi Agent RPC 未启动".to_owned()),
                )),
            }
        })
    }

    fn analyze_requirement(
        &self,
        input: RequirementAnalysisInput,
        events: Option<RequirementEventEmitter>,
    ) -> RequirementAnalysisFuture<'_> {
        Box::pin(async move {
            match &self.client {
                Some(client) => client.analyze_requirement(input, events).await,
                None => Err(AppError::internal(
                    self.startup_error
                        .clone()
                        .unwrap_or_else(|| "Pi Agent RPC 未启动".to_owned()),
                )),
            }
        })
    }
}

impl PiRpcClient {
    async fn start(session_dir: &Path) -> Result<Self, AppError> {
        tokio::fs::create_dir_all(session_dir).await?;
        let program = if cfg!(target_os = "windows") {
            "pi.cmd"
        } else {
            "pi"
        };
        let mut child = Command::new(program)
            .arg("--mode")
            .arg("rpc")
            .arg("--session-dir")
            .arg(session_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::internal("无法打开 Pi Agent RPC stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::internal("无法打开 Pi Agent RPC stdout"))?;

        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
            });
        }

        let client = Self {
            io_lock: Mutex::new(()),
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(BufReader::new(stdout)),
            child: Mutex::new(child),
        };
        client.drain_startup_noise().await?;
        Ok(client)
    }

    async fn get_available_models(&self) -> Result<Vec<PiModel>, AppError> {
        let request_id = format!(
            "raccoon-node-{}",
            PI_RPC_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        let response = self
            .send_command(json!({
                "id": request_id,
                "type": "get_available_models"
            }))
            .await?;
        let models = response
            .get("data")
            .and_then(|data| data.get("models"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        Ok(serde_json::from_value(models)?)
    }

    async fn analyze_requirement(
        &self,
        input: RequirementAnalysisInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<RequirementAnalysisOutput, AppError> {
        let high = input.model_settings.high.clone();
        let model_id = high
            .model_id
            .ok_or_else(|| AppError::bad_request("请先在模型设置中配置高档模型"))?;
        let models = self.get_available_models().await?;
        let model = models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| AppError::bad_request("高档模型不存在于 Pi Agent 已配置模型列表"))?;

        if let Some(session_file) = input.pi_session_file.as_deref() {
            self.switch_session(session_file).await?;
        } else {
            self.new_session().await?;
        }
        self.set_model(&model.provider, &model.id).await?;
        self.set_thinking_level(high.thinking_level.as_str())
            .await?;
        self.prompt(&build_requirement_prompt(&input)).await?;
        let mut pi_events = Vec::new();
        self.wait_for_agent_end_with_events(Duration::from_secs(120), |event| {
            if let Some(emitter) = &events {
                emitter.emit_pi_event(event.clone());
            }
            pi_events.push(event);
        })
        .await?;

        let assistant_text = self
            .get_last_assistant_text()
            .await?
            .unwrap_or_else(|| "Pi Agent 没有返回文本。".to_owned());
        let session_file = self.get_session_file().await?;
        Ok(parse_requirement_analysis(
            &assistant_text,
            session_file,
            build_pi_trace_metadata(&pi_events),
        ))
    }

    async fn set_model(&self, provider: &str, model_id: &str) -> Result<(), AppError> {
        self.send_command_with_auto_id(json!({
            "type": "set_model",
            "provider": provider,
            "modelId": model_id
        }))
        .await?;
        Ok(())
    }

    async fn set_thinking_level(&self, level: &str) -> Result<(), AppError> {
        self.send_command_with_auto_id(json!({
            "type": "set_thinking_level",
            "level": level
        }))
        .await?;
        Ok(())
    }

    async fn new_session(&self) -> Result<(), AppError> {
        self.send_command_with_auto_id(json!({ "type": "new_session" }))
            .await?;
        Ok(())
    }

    async fn switch_session(&self, session_path: &str) -> Result<(), AppError> {
        self.send_command_with_auto_id(json!({
            "type": "switch_session",
            "sessionPath": session_path
        }))
        .await?;
        Ok(())
    }

    async fn prompt(&self, message: &str) -> Result<(), AppError> {
        self.send_command_with_auto_id(json!({
            "type": "prompt",
            "message": message
        }))
        .await?;
        Ok(())
    }

    async fn get_last_assistant_text(&self) -> Result<Option<String>, AppError> {
        let response = self
            .send_command_with_auto_id(json!({ "type": "get_last_assistant_text" }))
            .await?;
        Ok(response
            .get("data")
            .and_then(|data| data.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    async fn get_session_file(&self) -> Result<Option<String>, AppError> {
        let response = self
            .send_command_with_auto_id(json!({ "type": "get_state" }))
            .await?;
        Ok(response
            .get("data")
            .and_then(|data| data.get("sessionFile"))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    async fn wait_for_agent_end_with_events<F>(
        &self,
        timeout: Duration,
        mut on_event: F,
    ) -> Result<(), AppError>
    where
        F: FnMut(Value) + Send,
    {
        let _guard = self.io_lock.lock().await;
        let mut stdout = self.stdout.lock().await;
        let mut line = String::new();
        let wait = async {
            loop {
                line.clear();
                let read = stdout.read_line(&mut line).await?;
                if read == 0 {
                    return Err(AppError::internal("Pi Agent RPC 已退出"));
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let value: Value = serde_json::from_str(trimmed)?;
                if value.get("type") != Some(&json!("response")) {
                    let is_agent_end = value.get("type") == Some(&json!("agent_end"));
                    on_event(value);
                    if is_agent_end {
                        return Ok(());
                    }
                    continue;
                }
                if value.get("type") == Some(&json!("agent_end")) {
                    return Ok(());
                }
            }
        };
        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| AppError::internal("等待 Pi Agent 需求分析超时"))?
    }

    async fn send_command_with_auto_id(&self, mut command: Value) -> Result<Value, AppError> {
        let request_id = format!(
            "raccoon-node-{}",
            PI_RPC_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        command["id"] = json!(request_id);
        self.send_command(command).await
    }

    async fn send_command(&self, command: Value) -> Result<Value, AppError> {
        let request_id = command
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::internal("Pi RPC 请求缺少 id"))?
            .to_owned();

        let _guard = self.io_lock.lock().await;
        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(command.to_string().as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
        }

        let mut stdout = self.stdout.lock().await;
        let mut line = String::new();
        loop {
            line.clear();
            let read = stdout.read_line(&mut line).await?;
            if read == 0 {
                return Err(AppError::internal("Pi Agent RPC 已退出"));
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let value: Value = serde_json::from_str(trimmed)?;
            if value.get("type") != Some(&json!("response")) {
                continue;
            }
            if value.get("id").and_then(Value::as_str) != Some(request_id.as_str()) {
                continue;
            }
            if value.get("success") == Some(&json!(false)) {
                let message = value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Pi Agent RPC 请求失败");
                return Err(AppError::internal(message));
            }
            return Ok(value);
        }
    }

    async fn drain_startup_noise(&self) -> Result<(), AppError> {
        let mut stdout = self.stdout.lock().await;
        let mut line = String::new();
        loop {
            line.clear();
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                stdout.read_line(&mut line),
            )
            .await
            {
                Ok(Ok(0)) => break,
                Ok(Ok(_)) => continue,
                Ok(Err(error)) if error.kind() == ErrorKind::Interrupted => continue,
                Ok(Err(error)) => return Err(AppError::Io(error)),
                Err(_) => break,
            }
        }
        Ok(())
    }
}

impl Drop for PiRpcClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

fn validate_model_settings(settings: &ModelSettings, models: &[PiModel]) -> Result<(), AppError> {
    validate_tier_model("低", &settings.low, models)?;
    validate_tier_model("中", &settings.medium, models)?;
    validate_tier_model("高", &settings.high, models)?;
    Ok(())
}

fn validate_tier_model(
    tier_name: &str,
    tier: &ModelTierSetting,
    models: &[PiModel],
) -> Result<(), AppError> {
    let Some(model_id) = tier.model_id.as_deref() else {
        return Err(AppError::bad_request(format!("{tier_name}档模型不能为空")));
    };

    if models.iter().any(|model| model.id == model_id) {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "{tier_name}档模型不存在于 Pi Agent 已配置模型列表"
        )))
    }
}

fn model_summary_description(settings: &ModelSettings) -> String {
    if settings.low.model_id.is_some()
        && settings.medium.model_id.is_some()
        && settings.high.model_id.is_some()
    {
        "低 / 中 / 高档模型已配置".to_owned()
    } else {
        "默认模型待配置".to_owned()
    }
}

#[derive(Debug)]
enum AppError {
    BadRequest(String),
    NotFound(String),
    Internal(String),
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, message),
            Self::Internal(message) => (StatusCode::INTERNAL_SERVER_ERROR, message),
            Self::Io(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
            Self::Json(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };

        (status, Json(ApiError { message })).into_response()
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) | Self::NotFound(message) | Self::Internal(message) => {
                formatter.write_str(message)
            }
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

async fn write_json(path: &Path, data: &AppData) -> Result<(), AppError> {
    let mut content = serde_json::to_string_pretty(data)?;
    content.push('\n');
    let parent = path
        .parent()
        .ok_or_else(|| AppError::internal(format!("无法获取 {} 的父目录", path.display())))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("app.json");
    let temp_name = format!(".{file_name}.{}.tmp", Utc::now().timestamp_millis());
    let temp_path = parent.join(temp_name);

    tokio::fs::write(&temp_path, content).await?;
    if let Err(error) = tokio::fs::rename(&temp_path, path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error.into());
    }
    Ok(())
}

async fn clone_git_repo(git_url: &str, repo_dir: &Path) -> Result<(), AppError> {
    let output = Command::new("git")
        .arg("clone")
        .arg(git_url)
        .arg(repo_dir)
        .output()
        .await?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let message = if stderr.is_empty() {
        "Git clone 失败".to_owned()
    } else {
        format!("Git clone 失败：{stderr}")
    };
    Err(AppError::bad_request(message))
}

async fn remove_dir_if_exists(path: &Path) -> Result<(), AppError> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::Io(error)),
    }
}

fn data_root_from_file(path: &Path) -> Result<PathBuf, AppError> {
    Ok(path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf())
}

fn ensure_child_path(root: &Path, child: &Path) -> Result<(), AppError> {
    let root_components = normalize_components(root);
    let child_components = normalize_components(child);
    if child_components.starts_with(&root_components) {
        Ok(())
    } else {
        Err(AppError::bad_request("项目目录必须位于数据目录内"))
    }
}

fn normalize_components(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            Component::RootDir => Some("/".to_owned()),
            Component::Prefix(value) => Some(value.as_os_str().to_string_lossy().to_string()),
            Component::CurDir => None,
            Component::ParentDir => Some("..".to_owned()),
        })
        .collect()
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch.is_whitespace() || matches!(ch, '-' | '_')) && !slug.ends_with('-') {
            slug.push('-');
        }
    }

    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() {
        "project".to_owned()
    } else {
        slug
    }
}

fn derive_requirement_title(message: &str) -> String {
    let compact = message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(24)
        .collect::<String>();
    if compact.is_empty() {
        "未命名需求".to_owned()
    } else {
        compact
    }
}

fn sort_requirements_desc(requirements: &mut [Requirement]) {
    requirements.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
}

fn data_file_path() -> PathBuf {
    if let Ok(path) = env::var("RACCOON_DATA_FILE") {
        return PathBuf::from(path);
    }

    if let Some(build_root) = build_root_from_current_exe() {
        return build_root.join("data/app.json");
    }

    PathBuf::from("data/app.json")
}

fn public_dir_path() -> PathBuf {
    if let Ok(path) = env::var("RACCOON_PUBLIC_DIR") {
        return PathBuf::from(path);
    }

    if let Some(build_root) = build_root_from_current_exe() {
        return build_root.join("public");
    }

    PathBuf::from("frontend/dist")
}

fn server_addr() -> SocketAddr {
    let host = env::var("RACCOON_HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
    let port = env::var("RACCOON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3001);

    format!("{host}:{port}")
        .parse()
        .expect("invalid RACCOON_HOST or RACCOON_PORT")
}

fn build_root_from_current_exe() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let bin_dir = exe.parent()?;
    if bin_dir.file_name()?.to_string_lossy() != "bin" {
        return None;
    }
    let build_root = bin_dir.parent()?.to_path_buf();
    if build_root.join("public").exists() || build_root.join("data").exists() {
        Some(build_root)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[derive(Clone)]
    struct FakeModelProvider {
        result: Result<Vec<PiModel>, String>,
        analysis: Result<RequirementAnalysisOutput, String>,
    }

    impl ModelProvider for FakeModelProvider {
        fn available_models(&self) -> ModelProviderFuture<'_> {
            Box::pin(async move { self.result.clone().map_err(AppError::internal) })
        }

        fn analyze_requirement(
            &self,
            _input: RequirementAnalysisInput,
            _events: Option<RequirementEventEmitter>,
        ) -> RequirementAnalysisFuture<'_> {
            Box::pin(async move { self.analysis.clone().map_err(AppError::internal) })
        }
    }

    fn fake_provider(models: Vec<PiModel>) -> Arc<dyn ModelProvider> {
        Arc::new(FakeModelProvider {
            result: Ok(models),
            analysis: Ok(RequirementAnalysisOutput {
                status: RequirementStatus::Clarifying,
                assistant_message: "请补充目标用户和验收标准。".to_owned(),
                progress: "正在澄清需求。".to_owned(),
                clarifications: vec![test_clarification("q1")],
                draft: None,
                pi_session_file: Some("session.json".to_owned()),
                error: None,
                trace: None,
            }),
        })
    }

    fn fake_analysis_provider(analysis: RequirementAnalysisOutput) -> Arc<dyn ModelProvider> {
        Arc::new(FakeModelProvider {
            result: Ok(vec![test_model("test/model", "Test Model")]),
            analysis: Ok(analysis),
        })
    }

    fn fake_error_provider(message: &str) -> Arc<dyn ModelProvider> {
        Arc::new(FakeModelProvider {
            result: Err(message.to_owned()),
            analysis: Err(message.to_owned()),
        })
    }

    fn test_model(id: &str, name: &str) -> PiModel {
        PiModel {
            id: id.to_owned(),
            name: name.to_owned(),
            provider: id.split('/').next().unwrap_or("test").to_owned(),
            reasoning: true,
        }
    }

    #[tokio::test]
    async fn initializes_json_store() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("app.json");
        let store = JsonStore::open(path.clone()).await.unwrap();

        assert!(path.exists());
        assert!(store.data.projects.is_empty());
        assert_eq!(store.data.settings_summary.title, "设置");
        assert_eq!(
            store.data.model_settings.low.thinking_level,
            ThinkingLevel::Low
        );
    }

    #[tokio::test]
    async fn creates_project_and_rejects_invalid_names() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("app.json");
        let mut store = JsonStore::open(path).await.unwrap();

        let project = store
            .create_project(
                "Demo Project".to_owned(),
                temp_git_repo(temp_dir.path()).to_string_lossy().to_string(),
            )
            .await
            .unwrap();
        assert_eq!(project.name, "Demo Project");
        assert!(project.id.starts_with("demo-project-"));
        assert!(Path::new(&project.local_path).ends_with("repo"));

        let empty = store
            .create_project(
                "   ".to_owned(),
                temp_git_repo(temp_dir.path()).to_string_lossy().to_string(),
            )
            .await
            .unwrap_err();
        assert!(matches!(empty, AppError::BadRequest(_)));

        let empty_git = store
            .create_project("No Git".to_owned(), "   ".to_owned())
            .await
            .unwrap_err();
        assert!(matches!(empty_git, AppError::BadRequest(_)));

        let duplicate = store
            .create_project(
                "demo project".to_owned(),
                temp_git_repo(temp_dir.path()).to_string_lossy().to_string(),
            )
            .await
            .unwrap_err();
        assert!(matches!(duplicate, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn clone_failure_does_not_write_project() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("app.json");
        let mut store = JsonStore::open(path).await.unwrap();

        let error = store
            .create_project("Broken".to_owned(), "/missing/repo.git".to_owned())
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(store.data.projects.is_empty());
        assert!(!store.data_root.join("projects").join("broken").exists());
    }

    #[tokio::test]
    async fn deletes_project_record_and_local_directory() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("app.json");
        let mut store = JsonStore::open(path).await.unwrap();
        let repo = temp_git_repo(temp_dir.path());

        let project = store
            .create_project("Delete Me".to_owned(), repo.to_string_lossy().to_string())
            .await
            .unwrap();
        let project_dir = store.project_dir(&project.id).unwrap();
        assert!(project_dir.exists());

        store.delete_project(&project.id).await.unwrap();

        assert!(store.data.projects.is_empty());
        assert!(!project_dir.exists());

        let missing = store.delete_project("missing").await.unwrap_err();
        assert!(matches!(missing, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn serves_start_and_create_project_api() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = JsonStore::open(temp_dir.path().join("data/app.json"))
            .await
            .unwrap();
        let app = build_app_with_model_provider(
            store,
            PathBuf::from("frontend/dist"),
            fake_provider(vec![test_model("test/model", "Test Model")]),
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/start")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "Alpha",
                            "git_url": temp_git_repo(temp_dir.path()).to_string_lossy()
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let project: Project = serde_json::from_slice(&body).unwrap();
        assert_eq!(project.name, "Alpha");

        let store = JsonStore::open(temp_dir.path().join("data/app.json"))
            .await
            .unwrap();
        let response = build_app_with_model_provider(
            store,
            PathBuf::from("frontend/dist"),
            fake_provider(vec![test_model("test/model", "Test Model")]),
        )
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/projects/{}", project.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn model_settings_api_returns_models_and_handles_rpc_error() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = JsonStore::open(temp_dir.path().join("data/app.json"))
            .await
            .unwrap();
        let app = build_app_with_model_provider(
            store,
            PathBuf::from("frontend/dist"),
            fake_provider(vec![test_model("test/model-a", "Model A")]),
        );

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/settings/models")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["rpc_status"], "ready");
        assert_eq!(value["models"][0]["id"], "test/model-a");

        let store = JsonStore::open(temp_dir.path().join("error/app.json"))
            .await
            .unwrap();
        let app = build_app_with_model_provider(
            store,
            PathBuf::from("frontend/dist"),
            fake_error_provider("rpc down"),
        );
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/settings/models")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["rpc_status"], "error");
        assert_eq!(value["models"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn model_settings_save_validates_models_and_allows_reuse() {
        let temp_dir = tempfile::tempdir().unwrap();
        let data_path = temp_dir.path().join("data/app.json");
        let store = JsonStore::open(data_path.clone()).await.unwrap();
        let app = build_app_with_model_provider(
            store,
            PathBuf::from("frontend/dist"),
            fake_provider(vec![test_model("test/model-a", "Model A")]),
        );

        let valid_body = r#"{
            "low": { "model_id": "test/model-a", "thinking_level": "low" },
            "medium": { "model_id": "test/model-a", "thinking_level": "medium" },
            "high": { "model_id": "test/model-a", "thinking_level": "high" }
        }"#;
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/settings/models")
                    .header("content-type", "application/json")
                    .body(Body::from(valid_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let stored = JsonStore::open(data_path).await.unwrap();
        assert_eq!(
            stored.data.model_summary.description,
            "低 / 中 / 高档模型已配置"
        );
        assert_eq!(
            stored.data.model_settings.high.model_id.as_deref(),
            Some("test/model-a")
        );

        let invalid_body = r#"{
            "low": { "model_id": "missing/model", "thinking_level": "low" },
            "medium": { "model_id": "test/model-a", "thinking_level": "medium" },
            "high": { "model_id": "test/model-a", "thinking_level": "high" }
        }"#;
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/settings/models")
                    .header("content-type", "application/json")
                    .body(Body::from(invalid_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn project_canvas_groups_requirements() {
        let temp_dir = tempfile::tempdir().unwrap();
        let data_path = temp_dir.path().join("data/app.json");
        let mut store = JsonStore::open(data_path).await.unwrap();
        let project = test_project("alpha");
        let now = Utc::now();
        store.data.projects.push(project.clone());
        store.data.requirements.push(test_requirement(
            "done",
            &project.id,
            RequirementStatus::Completed,
            now,
        ));
        store.data.requirements.push(test_requirement(
            "queued",
            &project.id,
            RequirementStatus::Queued,
            now,
        ));
        store.data.requirements.push(test_requirement(
            "active",
            &project.id,
            RequirementStatus::Clarifying,
            now,
        ));

        let canvas = store.project_canvas(&project.id).unwrap();
        assert_eq!(canvas.project.id, project.id);
        assert_eq!(canvas.active_requirement.unwrap().id, "active");
        assert_eq!(canvas.queued_requirements[0].id, "queued");
        assert_eq!(canvas.completed_requirements[0].id, "done");

        let missing = store.project_canvas("missing").unwrap_err();
        assert!(matches!(missing, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn requirement_api_creates_clarifies_and_confirms_queue() {
        let temp_dir = tempfile::tempdir().unwrap();
        let data_path = temp_dir.path().join("data/app.json");
        let mut store = JsonStore::open(data_path.clone()).await.unwrap();
        let project = test_project("alpha");
        store.data.projects.push(project.clone());
        write_json(&store.path, &store.data).await.unwrap();

        let app = build_app_with_model_provider(
            store,
            PathBuf::from("frontend/dist"),
            fake_analysis_provider(RequirementAnalysisOutput {
                status: RequirementStatus::DraftReady,
                assistant_message: "需求已经足够清晰。".to_owned(),
                progress: "需求已清晰。".to_owned(),
                clarifications: Vec::new(),
                draft: Some(RequirementDraft {
                    title: "新增登录".to_owned(),
                    summary: "实现登录入口。".to_owned(),
                    acceptance_criteria: vec!["可以提交账号密码".to_owned()],
                }),
                pi_session_file: Some("session.json".to_owned()),
                error: None,
                trace: None,
            }),
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/projects/{}/requirements", project.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"message":"新增登录"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let canvas: ProjectCanvasResponse = serde_json::from_slice(&body).unwrap();
        let active = canvas.active_requirement.unwrap();
        assert_eq!(active.status, RequirementStatus::Analyzing);

        let active =
            wait_for_requirement_status(&data_path, &active.id, RequirementStatus::DraftReady)
                .await;
        assert_eq!(active.draft.as_ref().unwrap().title, "新增登录");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/requirements/{}/confirm", active.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let canvas: ProjectCanvasResponse = serde_json::from_slice(&body).unwrap();
        assert!(canvas.active_requirement.is_none());
        assert_eq!(
            canvas.queued_requirements[0].status,
            RequirementStatus::Queued
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/projects/{}/requirements", project.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"message":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn requirement_clarification_answers_resume_analysis() {
        let temp_dir = tempfile::tempdir().unwrap();
        let data_path = temp_dir.path().join("data/app.json");
        let mut store = JsonStore::open(data_path).await.unwrap();
        let project = test_project("alpha");
        store.data.projects.push(project.clone());

        let (requirement_id, _) = store
            .create_requirement(&project.id, "实现需求澄清".to_owned())
            .await
            .unwrap();
        store
            .apply_requirement_analysis(
                &requirement_id,
                Ok(RequirementAnalysisOutput {
                    status: RequirementStatus::Clarifying,
                    assistant_message: "请确认范围。".to_owned(),
                    progress: "需要确认范围。".to_owned(),
                    clarifications: vec![test_clarification("q1")],
                    draft: None,
                    pi_session_file: Some("session.json".to_owned()),
                    error: None,
                    trace: Some(json!({
                        "type": "pi_trace",
                        "version": 1,
                        "trace": {
                            "thinking": "分析范围",
                            "output": "",
                            "tools": [],
                            "statuses": []
                        }
                    })),
                }),
            )
            .await
            .unwrap();

        let requirement = store
            .data
            .requirements
            .iter()
            .find(|requirement| requirement.id == requirement_id)
            .unwrap();
        assert_eq!(requirement.status, RequirementStatus::Clarifying);
        assert_eq!(requirement.clarification_round, 1);
        assert_eq!(requirement.clarifications.len(), 1);
        assert!(requirement
            .messages
            .iter()
            .any(|message| message.role == RequirementMessageRole::Trace));

        let (_, input) = store
            .submit_requirement_clarifications(
                &requirement_id,
                vec![ClarificationAnswerRequest {
                    clarification_id: "q1".to_owned(),
                    selected_options: vec!["small".to_owned()],
                    custom_text: None,
                }],
            )
            .await
            .unwrap();

        let requirement = store
            .data
            .requirements
            .iter()
            .find(|requirement| requirement.id == requirement_id)
            .unwrap();
        assert_eq!(requirement.status, RequirementStatus::Analyzing);
        assert!(requirement
            .messages
            .last()
            .unwrap()
            .content
            .contains("小范围"));
        assert_eq!(
            input.clarifications[0]
                .answer
                .as_ref()
                .unwrap()
                .selected_options,
            vec!["small"]
        );
    }

    #[tokio::test]
    async fn requirement_analysis_parse_failure_returns_failed_output() {
        let output = parse_requirement_analysis("普通文本", Some("session.json".to_owned()), None);
        assert_eq!(output.status, RequirementStatus::Failed);
        assert!(output.error.unwrap().contains("结构化 JSON"));

        let output = parse_requirement_analysis(
            r#"{"status":"needs_clarification","message":"请确认范围","draft":null}"#,
            None,
            None,
        );
        assert_eq!(output.status, RequirementStatus::Clarifying);
        assert_eq!(output.assistant_message, "请确认范围");

        let output = parse_requirement_analysis(
            r#"<!doctype html><html>{"status":"needs_clarification","progress":"需要确认展示范围","message":"请确认展示范围","clarifications":[{"question":"展示哪些内容？","type":"multi_choice","options":[{"label":"思考","description":"展示思考过程"},{"label":"工具","description":"展示工具调用"}]}],"draft":null}"#,
            None,
            None,
        );
        assert_eq!(output.status, RequirementStatus::Clarifying);
        assert_eq!(output.clarifications.len(), 1);
        assert_eq!(output.clarifications[0].options.len(), 2);
    }

    fn temp_git_repo(root: &Path) -> PathBuf {
        let bare = root.join(format!(
            "repo-{}.git",
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let output = std::process::Command::new("git")
            .arg("init")
            .arg("--bare")
            .arg(&bare)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "failed to init temp git repo: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        bare
    }

    fn test_project(id: &str) -> Project {
        let now = Utc::now();
        Project {
            id: id.to_owned(),
            name: id.to_owned(),
            git_url: format!("https://example.com/{id}.git"),
            local_path: format!("/tmp/{id}/repo"),
            created_at: now,
            updated_at: now,
        }
    }

    fn test_requirement(
        id: &str,
        project_id: &str,
        status: RequirementStatus,
        now: DateTime<Utc>,
    ) -> Requirement {
        Requirement {
            id: id.to_owned(),
            project_id: project_id.to_owned(),
            title: id.to_owned(),
            original_message: id.to_owned(),
            status,
            messages: vec![RequirementMessage {
                role: RequirementMessageRole::User,
                content: id.to_owned(),
                metadata: None,
                created_at: now,
            }],
            clarification_round: 0,
            clarifications: Vec::new(),
            draft: None,
            pi_session_file: None,
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn test_clarification(id: &str) -> RequirementClarification {
        RequirementClarification {
            id: id.to_owned(),
            question: "请选择范围".to_owned(),
            question_type: ClarificationQuestionType::SingleChoice,
            options: vec![
                ClarificationOption {
                    value: "small".to_owned(),
                    label: "小范围".to_owned(),
                    description: "先做核心流程".to_owned(),
                    recommended: true,
                },
                ClarificationOption {
                    value: "full".to_owned(),
                    label: "完整范围".to_owned(),
                    description: "一次完成全部能力".to_owned(),
                    recommended: false,
                },
            ],
            answer: None,
        }
    }

    async fn wait_for_requirement_status(
        data_path: &Path,
        requirement_id: &str,
        status: RequirementStatus,
    ) -> Requirement {
        for _ in 0..20 {
            let store = JsonStore::open(data_path.to_path_buf()).await.unwrap();
            if let Some(requirement) = store
                .data
                .requirements
                .iter()
                .find(|requirement| requirement.id == requirement_id)
            {
                if requirement.status == status {
                    return requirement.clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("requirement {requirement_id} did not reach {status:?}");
    }
}
