use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    env,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tokio::{process::Command, sync::Mutex};
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
struct AppState {
    store: Arc<Mutex<JsonStore>>,
}

struct JsonStore {
    path: PathBuf,
    data_root: PathBuf,
    data: AppData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct AppData {
    projects: Vec<Project>,
    settings_summary: SummaryNode,
    model_summary: SummaryNode,
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
struct SummaryNode {
    title: String,
    description: String,
}

#[derive(Debug, Deserialize)]
struct CreateProjectRequest {
    name: String,
    git_url: String,
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
    let state = AppState {
        store: Arc::new(Mutex::new(store)),
    };

    let api = Router::new()
        .route("/start", get(get_start))
        .route("/projects", post(create_project))
        .route("/projects/{id}", delete(delete_project))
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
        write_json(&self.path, &self.data).await?;
        Ok(())
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
            settings_summary: SummaryNode {
                title: "设置".to_owned(),
                description: "基础设置待配置".to_owned(),
            },
            model_summary: SummaryNode {
                title: "模型设置".to_owned(),
                description: "默认模型待配置".to_owned(),
            },
        }
    }
}

#[derive(Debug)]
enum AppError {
    BadRequest(String),
    NotFound(String),
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
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, message),
            Self::Io(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
            Self::Json(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };

        (status, Json(ApiError { message })).into_response()
    }
}

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
    let content = serde_json::to_string_pretty(data)?;
    tokio::fs::write(path, format!("{content}\n")).await?;
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

    #[tokio::test]
    async fn initializes_json_store() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("app.json");
        let store = JsonStore::open(path.clone()).await.unwrap();

        assert!(path.exists());
        assert!(store.data.projects.is_empty());
        assert_eq!(store.data.settings_summary.title, "设置");
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
        assert!(project.local_path.ends_with("/repo"));

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
        let app = build_app(
            temp_dir.path().join("data/app.json"),
            PathBuf::from("frontend/dist"),
        )
        .await;

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
                    .body(Body::from(format!(
                        r#"{{"name":"Alpha","git_url":"{}"}}"#,
                        temp_git_repo(temp_dir.path()).to_string_lossy()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let project: Project = serde_json::from_slice(&body).unwrap();
        assert_eq!(project.name, "Alpha");

        let response = build_app(
            temp_dir.path().join("data/app.json"),
            PathBuf::from("frontend/dist"),
        )
        .await
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
}
