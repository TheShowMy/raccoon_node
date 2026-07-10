use std::{
    collections::{BTreeSet, HashMap},
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

mod transport;

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};
use transport::PiRpcTransportConfig;

use crate::error::AppError;
use crate::models::{
    GitProvider, ModelProvider, ModelProviderActionFuture, ModelProviderFuture, ModelSettings,
    ModelTierSetting, PI_RPC_REQUEST_ID, PiModel, ProjectChatBranchFuture, ProjectChatEventEmitter,
    ProjectChatFuture, ProjectChatInput, ProjectChatOutput, ProjectChatSummarySyncFuture,
    ProjectChatSummarySyncInput, ProjectChatSummarySyncOutput, ProjectRequirementSummaryFuture,
    ProjectRequirementSummaryOutput, PromptImage, RequirementAnalysisFuture,
    RequirementAnalysisInput, RequirementAnalysisOutput, RequirementEventEmitter,
    RequirementModelTier, RequirementPlanFuture, RequirementPlanInput, RequirementReviewStatus,
    RequirementTaskExecutionFuture, RequirementTaskExecutionInput, RequirementTaskExecutionOutput,
    RequirementTaskKind,
};
use crate::prompt::attach_prompt_diagnostics;
use crate::requirement::{
    PiResponseFailure, build_recovery_guidance_json_repair_prompt, build_recovery_guidance_prompt,
    build_requirement_plan_json_repair_prompt, build_requirement_plan_prompt,
    build_requirement_prompt, build_requirement_task_prompt, build_task_output_json_repair_prompt,
    extract_pi_response, parse_recovery_guidance, parse_requirement_plan,
    parse_requirement_tool_analysis, parse_task_execution_output,
};
use crate::utils::{ensure_child_path, normalize_local_path, resolve_git_root};

const MAX_PROJECT_CLIENTS: usize = 5;
const MAX_JSON_REPAIR_ATTEMPTS: usize = 1;
const CLARIFICATION_EXTENSION: &str = include_str!("assets/raccoon-clarification.mjs");

async fn install_clarification_extension(data_root: &Path) -> Result<PathBuf, AppError> {
    let directory = data_root.join("extensions");
    ensure_child_path(data_root, &directory)?;
    tokio::fs::create_dir_all(&directory).await?;
    let path = directory.join("raccoon-clarification.mjs");
    ensure_child_path(&directory, &path)?;
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::bad_request("受管 Pi 插件不能是符号链接"));
    }
    if !matches!(
        tokio::fs::read_to_string(&path).await,
        Ok(content) if content == CLARIFICATION_EXTENSION
    ) {
        tokio::fs::write(&path, CLARIFICATION_EXTENSION).await?;
    }
    Ok(path)
}

pub struct PiRpcModelProvider {
    pub data_root: PathBuf,
    pub session_dir: PathBuf,
    pub global_client: Arc<tokio::sync::RwLock<Option<Arc<PiRpcClient>>>>,
    pub project_clients: tokio::sync::Mutex<HashMap<String, (Arc<PiRpcClient>, Instant)>>,
    pub project_chat_clients: tokio::sync::Mutex<HashMap<String, Arc<PiRpcClient>>>,
    pub project_chat_operations: tokio::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub startup_error: Option<String>,
    /// 0=Ready, 1=Reconnecting, 2=Error
    pub rpc_status: Arc<AtomicU8>,
    clarification_extension_path: Option<PathBuf>,
    clarification_extension_error: Option<String>,
    heartbeat_shutdown: Arc<AtomicBool>,
    heartbeat_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

const RPC_STATUS_READY: u8 = 0;
const RPC_STATUS_RECONNECTING: u8 = 1;
const RPC_STATUS_ERROR: u8 = 2;

impl PiRpcModelProvider {
    pub async fn start(data_root: PathBuf) -> Self {
        let session_dir = data_root.join("sessions");
        let (clarification_extension_path, clarification_extension_error) =
            match install_clarification_extension(&data_root).await {
                Ok(path) => (Some(path), None),
                Err(error) => (None, Some(error.to_string())),
            };
        let project_root = data_root
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| data_root.clone());
        let rpc_status = Arc::new(AtomicU8::new(RPC_STATUS_ERROR));
        let (global_client, startup_error) =
            match PiRpcClient::start(&session_dir, &project_root).await {
                Ok(client) => {
                    rpc_status.store(RPC_STATUS_READY, Ordering::Relaxed);
                    (Some(Arc::new(client)), None)
                }
                Err(error) => {
                    rpc_status.store(RPC_STATUS_ERROR, Ordering::Relaxed);
                    (
                        None,
                        Some(format!(
                            "无法启动 Pi Agent RPC。请确认 'pi' 已安装并在 PATH 中。错误：{}",
                            error
                        )),
                    )
                }
            };
        let global_client = Arc::new(tokio::sync::RwLock::new(global_client));
        let heartbeat_shutdown = Arc::new(AtomicBool::new(false));
        let heartbeat_task = Self::start_heartbeat(
            data_root.clone(),
            session_dir.clone(),
            global_client.clone(),
            rpc_status.clone(),
            heartbeat_shutdown.clone(),
        );
        Self {
            data_root,
            session_dir,
            global_client,
            project_clients: tokio::sync::Mutex::new(HashMap::new()),
            project_chat_clients: tokio::sync::Mutex::new(HashMap::new()),
            project_chat_operations: tokio::sync::Mutex::new(HashMap::new()),
            startup_error,
            rpc_status,
            clarification_extension_path,
            clarification_extension_error,
            heartbeat_shutdown,
            heartbeat_task: std::sync::Mutex::new(Some(heartbeat_task)),
        }
    }

    /// Spawn a background task that checks `get_state` every 30s.
    /// On failure: kills the child and restarts the Pi Agent process.
    fn start_heartbeat(
        data_root: PathBuf,
        session_dir: PathBuf,
        global_client_lock: Arc<tokio::sync::RwLock<Option<Arc<PiRpcClient>>>>,
        status_flag: Arc<AtomicU8>,
        shutdown: Arc<AtomicBool>,
    ) -> tokio::task::JoinHandle<()> {
        let project_root = data_root
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or(data_root);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                if status_flag.load(Ordering::Relaxed) == RPC_STATUS_RECONNECTING {
                    continue;
                }

                let is_healthy = {
                    let guard = global_client_lock.read().await;
                    match guard.as_ref() {
                        Some(client) => {
                            // Lightweight probe: get_state returns immediately.
                            client
                                .send_command(serde_json::json!({"type": "get_state"}))
                                .await
                                .is_ok()
                        }
                        None => false,
                    }
                };

                if is_healthy {
                    status_flag.store(RPC_STATUS_READY, Ordering::Relaxed);
                    continue;
                }

                tracing::warn!("Pi Agent RPC heartbeat failed — restarting...");
                status_flag.store(RPC_STATUS_RECONNECTING, Ordering::Relaxed);

                // Kill old child (if any) and start fresh.
                {
                    let mut guard = global_client_lock.write().await;
                    if let Some(client) = guard.take() {
                        client.shutdown().await;
                    }
                }

                match PiRpcClient::start(&session_dir, &project_root).await {
                    Ok(client) => {
                        tracing::info!("Pi Agent RPC restarted successfully");
                        let mut guard = global_client_lock.write().await;
                        *guard = Some(Arc::new(client));
                        status_flag.store(RPC_STATUS_READY, Ordering::Relaxed);
                    }
                    Err(error) => {
                        tracing::error!("Pi Agent RPC restart failed: {error}");
                        status_flag.store(RPC_STATUS_ERROR, Ordering::Relaxed);
                    }
                }
            }
        })
    }

    async fn shutdown_all(&self) {
        self.heartbeat_shutdown.store(true, Ordering::Relaxed);
        if let Some(task) = self
            .heartbeat_task
            .lock()
            .expect("heartbeat lock poisoned")
            .take()
        {
            task.abort();
        }
        if let Some(client) = self.global_client.write().await.take() {
            client.shutdown().await;
        }
        let clients = self
            .project_clients
            .lock()
            .await
            .drain()
            .map(|(_, (client, _))| client)
            .collect::<Vec<_>>();
        for client in clients {
            client.shutdown().await;
        }
        let chat_clients = self
            .project_chat_clients
            .lock()
            .await
            .drain()
            .map(|(_, client)| client)
            .collect::<Vec<_>>();
        for client in chat_clients {
            client.shutdown().await;
        }
    }

    async fn reload_clients(&self) -> Result<(), AppError> {
        self.rpc_status
            .store(RPC_STATUS_RECONNECTING, Ordering::Relaxed);
        if let Some(client) = self.global_client.write().await.take() {
            client.shutdown().await;
        }
        let clients = self
            .project_clients
            .lock()
            .await
            .drain()
            .map(|(_, (client, _))| client)
            .collect::<Vec<_>>();
        for client in clients {
            client.shutdown().await;
        }

        let project_root = self
            .data_root
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.data_root.clone());
        match PiRpcClient::start(&self.session_dir, &project_root).await {
            Ok(client) => {
                *self.global_client.write().await = Some(Arc::new(client));
                self.rpc_status.store(RPC_STATUS_READY, Ordering::Relaxed);
                Ok(())
            }
            Err(error) => {
                self.rpc_status.store(RPC_STATUS_ERROR, Ordering::Relaxed);
                Err(error)
            }
        }
    }

    async fn project_client(
        &self,
        project: &crate::models::Project,
    ) -> Result<Arc<PiRpcClient>, AppError> {
        let project_id = project.id.clone();
        let mut clients = self.project_clients.lock().await;

        if let Some((client, _last_used)) = clients.get_mut(&project_id) {
            *_last_used = Instant::now();
            return Ok(client.clone());
        }

        if clients.len() >= MAX_PROJECT_CLIENTS {
            Self::evict_oldest(&mut clients);
        }

        let working_dir = resolve_project_working_dir(&self.data_root, &project.local_path)?;

        let extension_path = self
            .clarification_extension_path
            .as_deref()
            .ok_or_else(|| {
                AppError::internal(
                    self.clarification_extension_error
                        .clone()
                        .unwrap_or_else(|| "受管需求澄清插件不可用".to_owned()),
                )
            })?;
        let client =
            PiRpcClient::start_with_extension(&self.session_dir, &working_dir, extension_path)
                .await?;
        let client = Arc::new(client);
        clients.insert(project_id, (client.clone(), Instant::now()));
        Ok(client)
    }

    fn evict_oldest(clients: &mut HashMap<String, (Arc<PiRpcClient>, Instant)>) {
        let oldest = clients
            .iter()
            .min_by_key(|(_id, (_client, instant))| *instant)
            .map(|(id, _)| id.clone());
        if let Some(id) = oldest {
            clients.remove(&id);
        }
    }
}

pub(crate) fn resolve_project_working_dir(
    data_root: &Path,
    local_path: &str,
) -> Result<PathBuf, AppError> {
    let project_root = data_root
        .parent()
        .ok_or_else(|| AppError::bad_request("数据目录缺少项目根目录"))?;
    let project_root = resolve_git_root(Some(project_root), project_root)?;
    let candidate = PathBuf::from(local_path);
    if !candidate.is_absolute() {
        return Err(AppError::bad_request("Pi 工作目录必须是绝对路径"));
    }
    let candidate = resolve_git_root(Some(&candidate), &candidate)?;
    if candidate == project_root {
        return Ok(candidate);
    }
    ensure_child_path(&data_root.join("worktrees"), &candidate)?;
    Ok(candidate)
}

impl ModelProvider for PiRpcModelProvider {
    fn available_models(&self) -> ModelProviderFuture<'_> {
        let startup_error = self.startup_error.clone();
        Box::pin(async move {
            let guard = self.global_client.read().await;
            match guard.as_ref() {
                Some(client) => client.get_available_models().await,
                None => Err(AppError::internal(
                    startup_error.unwrap_or_else(|| "Pi Agent RPC 未启动".to_owned()),
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
            let client = self.project_client(&input.project).await?;
            client.analyze_requirement(input, events).await
        })
    }

    fn plan_requirement_execution(
        &self,
        input: RequirementPlanInput,
        events: Option<RequirementEventEmitter>,
    ) -> RequirementPlanFuture<'_> {
        Box::pin(async move {
            let client = self.project_client(&input.project).await?;
            client.plan_requirement_execution(input, events).await
        })
    }

    fn execute_requirement_task(
        &self,
        input: RequirementTaskExecutionInput,
        events: Option<RequirementEventEmitter>,
    ) -> RequirementTaskExecutionFuture<'_> {
        Box::pin(async move {
            let (working_dir, branch_name, worktree_path) =
                prepare_task_workspace(&self.data_root, &input).await?;
            let no_session = input.task.kind == RequirementTaskKind::ReviewSubAgent;
            let client = if no_session {
                PiRpcClient::start_no_session(&working_dir).await?
            } else {
                PiRpcClient::start(&self.session_dir, &working_dir).await?
            };
            let mut input = input;
            if input.task.branch_name.is_none() {
                input.task.branch_name = branch_name;
            }
            if input.task.worktree_path.is_none() {
                input.task.worktree_path =
                    worktree_path.map(|path| path.to_string_lossy().to_string());
            }
            let mut output = match client.execute_requirement_task(input.clone(), events).await {
                Ok(output) => output,
                Err(error) => {
                    let session_file = if no_session {
                        None
                    } else {
                        match error.pi_session_file() {
                            Some(path) => Some(path.to_owned()),
                            None => client.get_session_file().await.ok().flatten(),
                        }
                    };
                    if no_session {
                        client.shutdown().await;
                    }
                    return Err(AppError::task_execution(error.to_string(), session_file));
                }
            };
            if no_session {
                client.shutdown().await;
            }
            if input.task.kind == RequirementTaskKind::MergeReview
                && output.review_status == Some(RequirementReviewStatus::Approved)
            {
                let publish = publish_merge_review(&self.data_root, &input, &output).await?;
                output.pull_request_url = publish.pull_request_url;
                output.merged_into = Some(publish.merged_into);
                output.cleanup_summary = Some(publish.cleanup_summary);
            }
            Ok(output)
        })
    }

    fn ask_project_chat(
        &self,
        input: ProjectChatInput,
        events: Option<ProjectChatEventEmitter>,
    ) -> ProjectChatFuture<'_> {
        Box::pin(async move {
            let project_id = input.project.id.clone();
            let operation = self
                .project_chat_operations
                .lock()
                .await
                .get(&project_id)
                .cloned()
                .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
            let result = async {
                let working_dir =
                    resolve_project_working_dir(&self.data_root, &input.project.local_path)?;
                let client = Arc::new(PiRpcClient::start(&self.session_dir, &working_dir).await?);
                self.project_chat_clients
                    .lock()
                    .await
                    .insert(project_id.clone(), client.clone());
                if operation.load(Ordering::Relaxed) {
                    client.cancel().await;
                }
                let output = client.ask_project_chat(input, events).await;
                self.project_chat_clients.lock().await.remove(&project_id);
                client.shutdown().await;
                output
            }
            .await;
            self.project_chat_operations
                .lock()
                .await
                .remove(&project_id);
            result
        })
    }

    fn generate_project_requirement_summary(
        &self,
        input: ProjectChatInput,
        events: Option<ProjectChatEventEmitter>,
    ) -> ProjectRequirementSummaryFuture<'_> {
        Box::pin(async move {
            let project_id = input.project.id.clone();
            let operation = self
                .project_chat_operations
                .lock()
                .await
                .get(&project_id)
                .cloned()
                .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
            let result = async {
                let working_dir =
                    resolve_project_working_dir(&self.data_root, &input.project.local_path)?;
                let extension_path = self
                    .clarification_extension_path
                    .as_deref()
                    .ok_or_else(|| AppError::internal("受管需求说明插件不可用"))?;
                let client = Arc::new(
                    PiRpcClient::start_with_extension(
                        &self.session_dir,
                        &working_dir,
                        extension_path,
                    )
                    .await?,
                );
                self.project_chat_clients
                    .lock()
                    .await
                    .insert(project_id.clone(), client.clone());
                if operation.load(Ordering::Relaxed) {
                    client.cancel().await;
                }
                let output = client
                    .generate_project_requirement_summary(input, events)
                    .await;
                self.project_chat_clients.lock().await.remove(&project_id);
                client.shutdown().await;
                output
            }
            .await;
            self.project_chat_operations
                .lock()
                .await
                .remove(&project_id);
            result
        })
    }

    fn clone_project_chat_for_requirement(
        &self,
        input: ProjectChatInput,
    ) -> ProjectChatBranchFuture<'_> {
        Box::pin(async move {
            if input.pi_session_file.is_none() {
                return Ok(None);
            }
            {
                let mut operations = self.project_chat_operations.lock().await;
                if operations.contains_key(&input.project.id) {
                    return Err(AppError::conflict("普通会话正在运行，暂时无法创建需求分支"));
                }
                operations.insert(input.project.id.clone(), Arc::new(AtomicBool::new(false)));
            }
            let result = async {
                let working_dir =
                    resolve_project_working_dir(&self.data_root, &input.project.local_path)?;
                let client = PiRpcClient::start(&self.session_dir, &working_dir).await?;
                let result = client.clone_requirement_branch(&input).await;
                client.shutdown().await;
                result.map(Some)
            }
            .await;
            self.project_chat_operations
                .lock()
                .await
                .remove(&input.project.id);
            result
        })
    }

    fn sync_requirement_summary_to_project_chat(
        &self,
        input: ProjectChatSummarySyncInput,
        _events: Option<ProjectChatEventEmitter>,
    ) -> ProjectChatSummarySyncFuture<'_> {
        Box::pin(async move {
            let project_id = input.project.id.clone();
            let operation = self
                .project_chat_operations
                .lock()
                .await
                .get(&project_id)
                .cloned()
                .ok_or_else(|| AppError::conflict("需求摘要写回操作未启动"))?;
            let result = async {
                let working_dir =
                    resolve_project_working_dir(&self.data_root, &input.project.local_path)?;
                let client = Arc::new(PiRpcClient::start(&self.session_dir, &working_dir).await?);
                self.project_chat_clients
                    .lock()
                    .await
                    .insert(project_id.clone(), client.clone());
                if operation.load(Ordering::Relaxed) {
                    client.cancel().await;
                }
                let output = client.sync_requirement_summary(input).await;
                self.project_chat_clients.lock().await.remove(&project_id);
                client.shutdown().await;
                output
            }
            .await;
            self.project_chat_operations
                .lock()
                .await
                .remove(&project_id);
            result
        })
    }

    fn begin_project_chat(&self, project_id: &str) -> ModelProviderActionFuture<'_> {
        let project_id = project_id.to_owned();
        Box::pin(async move {
            let mut operations = self.project_chat_operations.lock().await;
            if operations.contains_key(&project_id) {
                return Err(AppError::conflict("普通会话正在运行"));
            }
            operations.insert(project_id, Arc::new(AtomicBool::new(false)));
            Ok(())
        })
    }

    fn cancel_project_chat(&self, project_id: &str) -> ModelProviderActionFuture<'_> {
        let project_id = project_id.to_owned();
        Box::pin(async move {
            let operation = self
                .project_chat_operations
                .lock()
                .await
                .get(&project_id)
                .cloned()
                .ok_or_else(|| AppError::conflict("项目问答当前未运行"))?;
            operation.store(true, Ordering::Relaxed);
            if let Some(client) = self
                .project_chat_clients
                .lock()
                .await
                .get(&project_id)
                .cloned()
            {
                client.cancel().await;
            }
            Ok(())
        })
    }

    fn release_project(&self, project_id: &str) -> ModelProviderActionFuture<'_> {
        let project_id = project_id.to_owned();
        Box::pin(async move {
            let client = self
                .project_clients
                .lock()
                .await
                .remove(&project_id)
                .map(|(client, _)| client);
            if let Some(client) = client {
                client.shutdown().await;
            }
            Ok(())
        })
    }

    fn cancel_requirement_analysis(&self, project_id: &str) -> ModelProviderActionFuture<'_> {
        let project_id = project_id.to_owned();
        Box::pin(async move {
            let mut clients = self.project_clients.lock().await;
            if let Some((client, _)) = clients.remove(&project_id) {
                client.cancel().await;
            }
            Ok(())
        })
    }

    fn respond_requirement_interaction(
        &self,
        project_id: &str,
        request_id: &str,
        response: Value,
    ) -> ModelProviderActionFuture<'_> {
        let project_id = project_id.to_owned();
        let request_id = request_id.to_owned();
        Box::pin(async move {
            let client = self
                .project_clients
                .lock()
                .await
                .get(&project_id)
                .map(|(client, _)| client.clone())
                .ok_or_else(|| AppError::conflict("澄清会话已结束，请重新分析"))?;
            client
                .send_extension_ui_response(&request_id, response)
                .await
        })
    }

    fn reload(&self) -> ModelProviderActionFuture<'_> {
        Box::pin(async move { self.reload_clients().await })
    }

    fn shutdown(&self) -> ModelProviderActionFuture<'_> {
        Box::pin(async move {
            self.shutdown_all().await;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;
pub struct PiRpcIo {
    pub stdout: BufReader<ChildStdout>,
    pub child: Child,
    /// Set to true to cancel an ongoing Pi Agent session.
    pub cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub struct PiRpcClient {
    pub stdin: tokio::sync::Mutex<ChildStdin>,
    pub io: tokio::sync::Mutex<PiRpcIo>,
    pub session_dir: PathBuf,
    pub working_dir: PathBuf,
    pub cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    cancel_notify: Arc<tokio::sync::Notify>,
    /// True when started with `--no-session`; skips session creation and validation.
    pub no_session: bool,
}

impl PiRpcClient {
    pub async fn start(session_dir: &Path, working_dir: &Path) -> Result<Self, AppError> {
        Self::start_with_optional_extension(session_dir, working_dir, None).await
    }

    pub async fn start_with_extension(
        session_dir: &Path,
        working_dir: &Path,
        extension_path: &Path,
    ) -> Result<Self, AppError> {
        Self::start_with_optional_extension(session_dir, working_dir, Some(extension_path)).await
    }

    async fn start_with_optional_extension(
        session_dir: &Path,
        working_dir: &Path,
        extension_path: Option<&Path>,
    ) -> Result<Self, AppError> {
        let session_dir = normalize_local_path(session_dir)?;
        let working_dir = normalize_local_path(working_dir)?;
        tokio::fs::create_dir_all(&session_dir).await?;

        let candidates: Vec<&str> = if cfg!(target_os = "windows") {
            vec!["pi.cmd", "pi.exe", "pi"]
        } else {
            vec!["pi"]
        };

        let mut last_error = None;
        for program in &candidates {
            match Self::start_with_program(program, &session_dir, &working_dir, extension_path)
                .await
            {
                Ok(client) => {
                    tracing::info!("started Pi Agent RPC using {}", program);
                    return Ok(client);
                }
                Err(error) => {
                    tracing::debug!("failed to start Pi Agent RPC with {}: {}", program, error);
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| AppError::internal("未知错误")))
    }

    pub async fn start_no_session(working_dir: &Path) -> Result<Self, AppError> {
        let working_dir = normalize_local_path(working_dir)?;
        let candidates: Vec<&str> = if cfg!(target_os = "windows") {
            vec!["pi.cmd", "pi.exe", "pi"]
        } else {
            vec!["pi"]
        };
        let mut last_error = None;
        for program in &candidates {
            match Self::start_with_program_no_session(program, &working_dir).await {
                Ok(client) => {
                    tracing::info!("started Pi Agent RPC (no-session) using {}", program);
                    return Ok(client);
                }
                Err(error) => {
                    tracing::debug!(
                        "failed to start Pi Agent RPC (no-session) with {}: {}",
                        program,
                        error
                    );
                    last_error = Some(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| AppError::internal("未知错误")))
    }

    async fn start_with_program_no_session(
        program: &str,
        working_dir: &Path,
    ) -> Result<Self, AppError> {
        let transport_config = PiRpcTransportConfig::no_session(program, working_dir);
        let _pi_session_config = transport_config.to_pi_session_config();
        let mut command = if cfg!(windows) && program.ends_with(".cmd") {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", program]);
            command
        } else {
            Command::new(program)
        };
        let mut child = command
            .arg("--mode")
            .arg("rpc")
            .args(transport_config.extra_args())
            .current_dir(working_dir)
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

        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancel_notify = Arc::new(tokio::sync::Notify::new());
        let client = Self {
            stdin: tokio::sync::Mutex::new(stdin),
            io: tokio::sync::Mutex::new(PiRpcIo {
                stdout: BufReader::new(stdout),
                child,
                cancelled: cancelled.clone(),
            }),
            session_dir: PathBuf::new(),
            working_dir: working_dir.to_path_buf(),
            cancelled,
            cancel_notify,
            no_session: true,
        };
        client.drain_startup_noise().await?;
        Ok(client)
    }

    async fn start_with_program(
        program: &str,
        session_dir: &Path,
        working_dir: &Path,
        extension_path: Option<&Path>,
    ) -> Result<Self, AppError> {
        let transport_config =
            PiRpcTransportConfig::session(program, session_dir, working_dir, extension_path);
        let _pi_session_config = transport_config.to_pi_session_config();
        let mut command = if cfg!(windows) && program.ends_with(".cmd") {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", program]);
            command
        } else {
            Command::new(program)
        };
        command
            .arg("--mode")
            .arg("rpc")
            .args(transport_config.extra_args());
        if let Some(session_dir) = transport_config.session_dir.as_deref() {
            command.arg("--session-dir").arg(session_dir);
        }
        let mut child = command
            .current_dir(working_dir)
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

        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancel_notify = Arc::new(tokio::sync::Notify::new());
        let client = Self {
            stdin: tokio::sync::Mutex::new(stdin),
            io: tokio::sync::Mutex::new(PiRpcIo {
                stdout: BufReader::new(stdout),
                child,
                cancelled: cancelled.clone(),
            }),
            session_dir: session_dir.to_path_buf(),
            working_dir: working_dir.to_path_buf(),
            cancelled,
            cancel_notify,
            no_session: false,
        };
        client.drain_startup_noise().await?;
        Ok(client)
    }

    pub async fn get_available_models(&self) -> Result<Vec<PiModel>, AppError> {
        let response = self
            .send_command(serde_json::json!({
                "type": "get_available_models"
            }))
            .await?;
        let models = response
            .get("data")
            .and_then(|data| data.get("models"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        Ok(serde_json::from_value(models)?)
    }

    pub async fn analyze_requirement(
        &self,
        input: RequirementAnalysisInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<RequirementAnalysisOutput, AppError> {
        let session_reused = self
            .restore_or_new_session(input.pi_session_file.as_deref())
            .await?;
        let session_file = self.get_session_file().await?;
        if let (Some(emitter), Some(session_file)) = (&events, &session_file) {
            emitter.emit_pi_event(serde_json::json!({
                "type": "raccoon_session_bound",
                "sessionFile": session_file,
            }));
        }
        self.ensure_clarification_extension().await?;
        self.prepare_high_model(&input.model_settings).await?;
        let rendered_prompt = build_requirement_prompt(&input);
        self.prompt_with_images(&rendered_prompt.markdown, &input.prompt_images)
            .await?;
        let mut pi_events = Vec::new();
        self.wait_for_agent_end_with_events(
            Duration::from_secs(120), // first warning at 120s
            Duration::from_secs(600), // hard stop at 600s (10 min)
            &events,
            |event| {
                if let Some(emitter) = &events {
                    emitter.emit_pi_event(event.clone());
                }
                pi_events.push(event);
            },
        )
        .await?;

        let trace = self
            .attach_session_usage(
                attach_prompt_diagnostics(
                    crate::requirement::build_pi_trace_metadata(&pi_events),
                    &rendered_prompt.diagnostics,
                ),
                session_reused,
            )
            .await;
        Ok(parse_requirement_tool_analysis(
            &pi_events,
            session_file,
            trace,
        ))
    }

    async fn ensure_clarification_extension(&self) -> Result<(), AppError> {
        let response = self
            .send_command(serde_json::json!({ "type": "get_commands" }))
            .await?;
        let available = response
            .pointer("/data/commands")
            .and_then(Value::as_array)
            .is_some_and(|commands| {
                commands.iter().any(|command| {
                    command.get("name").and_then(Value::as_str) == Some("raccoon-requirements-v2")
                })
            });
        if !available {
            return Err(AppError::internal(
                "受管 Pi 需求澄清插件未加载或协议版本不兼容",
            ));
        }
        Ok(())
    }

    async fn ensure_project_requirement_summary_extension(&self) -> Result<(), AppError> {
        let response = self
            .send_command(serde_json::json!({ "type": "get_commands" }))
            .await?;
        let available = response
            .pointer("/data/commands")
            .and_then(Value::as_array)
            .is_some_and(|commands| {
                commands.iter().any(|command| {
                    command.get("name").and_then(Value::as_str)
                        == Some("raccoon-project-requirement-summary-v1")
                })
            });
        if available {
            Ok(())
        } else {
            Err(AppError::internal(
                "受管项目问答需求说明插件未加载或协议版本不兼容",
            ))
        }
    }

    pub async fn plan_requirement_execution(
        &self,
        input: RequirementPlanInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<crate::models::RequirementExecutionPlan, AppError> {
        self.new_session().await?;
        self.prepare_high_model(&input.model_settings).await?;
        let rendered_prompt = build_requirement_plan_prompt(&input.requirement);
        let mut response = self
            .prompt_and_extract_response(
                &rendered_prompt.markdown,
                Duration::from_secs(600),
                Duration::from_secs(600),
                &events,
                false,
            )
            .await?;
        response.trace = attach_prompt_diagnostics(response.trace, &rendered_prompt.diagnostics);
        match parse_requirement_plan(&response.assistant_text) {
            Ok(plan) => Ok(plan),
            Err(parse_error) => {
                let repair_prompt = build_requirement_plan_json_repair_prompt(
                    &parse_error.to_string(),
                    &response.assistant_text,
                );
                let repaired = self
                    .prompt_and_extract_response(
                        &repair_prompt,
                        Duration::from_secs(600),
                        Duration::from_secs(600),
                        &events,
                        true,
                    )
                    .await?;
                parse_requirement_plan(&repaired.assistant_text).map_err(|repair_error| {
                    AppError::internal(format!(
                        "执行计划 JSON 解析失败，已尝试同会话修复：{repair_error}"
                    ))
                })
            }
        }
    }

    pub async fn execute_requirement_task(
        &self,
        input: RequirementTaskExecutionInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<RequirementTaskExecutionOutput, AppError> {
        let session_reused = self
            .restore_or_new_session(input.task.pi_session_file.as_deref())
            .await?;
        if input.task.recovery_stage == crate::models::RequirementRecoveryStage::GuidedRetry
            && input.task.recovery_guidance.is_none()
        {
            self.prepare_high_model(&input.model_settings).await?;
            let timeout = Duration::from_secs(input.task.timeout_seconds.min(600));
            let recovery_prompt = build_recovery_guidance_prompt(&input.task);
            let mut response = self
                .prompt_and_extract_response(
                    &recovery_prompt.markdown,
                    timeout,
                    timeout,
                    &events,
                    session_reused,
                )
                .await?;
            response.trace =
                attach_prompt_diagnostics(response.trace, &recovery_prompt.diagnostics);
            let guidance = match parse_recovery_guidance(&response.assistant_text) {
                Ok(guidance) => guidance,
                Err(parse_error) => {
                    let repair_prompt = build_recovery_guidance_json_repair_prompt(
                        &parse_error.to_string(),
                        &response.assistant_text,
                    );
                    response = self
                        .prompt_and_extract_response(
                            &repair_prompt,
                            timeout,
                            timeout,
                            &events,
                            true,
                        )
                        .await?;
                    response.trace =
                        attach_prompt_diagnostics(response.trace, &recovery_prompt.diagnostics);
                    parse_recovery_guidance(&response.assistant_text).map_err(|repair_error| {
                        AppError::internal(format!(
                            "恢复指导 JSON 解析失败，已尝试同会话修复：{repair_error}"
                        ))
                    })?
                }
            };
            return Ok(RequirementTaskExecutionOutput {
                result_summary: "高档模型恢复方案已生成。".to_owned(),
                pi_session_file: self.get_session_file().await?,
                branch_name: input.task.branch_name.clone(),
                worktree_path: input.task.worktree_path.clone(),
                review_status: None,
                review_feedback: None,
                pull_request_url: None,
                merged_into: None,
                cleanup_summary: None,
                execution_warning: None,
                changed: None,
                no_op_reason: None,
                recovery_guidance: Some(guidance),
                trace: response.trace,
            });
        }

        self.prepare_model_tier(&input.model_settings, input.task.model_tier)
            .await?;
        let task_timeout = Duration::from_secs(input.task.timeout_seconds);
        let rendered_prompt =
            build_requirement_task_prompt(&input.requirement, &input.plan, &input.task);
        let mut response = self
            .prompt_and_extract_response(
                &rendered_prompt.markdown,
                task_timeout,
                task_timeout,
                &events,
                session_reused,
            )
            .await
            .map_err(|error| {
                AppError::internal(format!(
                    "节点「{}」执行超时或失败：{error}",
                    input.task.title
                ))
            })?;
        response.trace = attach_prompt_diagnostics(response.trace, &rendered_prompt.diagnostics);
        let mut output =
            match parse_task_execution_output(&response.assistant_text, response.trace.clone()) {
                Ok(output) => output,
                Err(parse_error) => {
                    let mut last_error = parse_error;
                    let mut repaired_output = None;
                    for _ in 0..MAX_JSON_REPAIR_ATTEMPTS {
                        let repair_prompt = build_task_output_json_repair_prompt(
                            &input.task,
                            &last_error.to_string(),
                            &response.assistant_text,
                        );
                        response = self
                            .prompt_and_extract_response(
                                &repair_prompt,
                                task_timeout,
                                task_timeout,
                                &events,
                                true,
                            )
                            .await?;
                        response.trace =
                            attach_prompt_diagnostics(response.trace, &rendered_prompt.diagnostics);
                        match parse_task_execution_output(
                            &response.assistant_text,
                            response.trace.clone(),
                        ) {
                            Ok(output) => {
                                repaired_output = Some(output);
                                break;
                            }
                            Err(error) => last_error = error,
                        }
                    }
                    repaired_output.ok_or_else(|| {
                        AppError::internal(format!(
                            "任务结果 JSON 解析失败，已尝试同会话修复：{last_error}"
                        ))
                    })?
                }
            };
        output.recovery_guidance = input.task.recovery_guidance.clone();
        output.pi_session_file = self.get_session_file().await?;
        output.branch_name = input.task.branch_name.clone();
        output.worktree_path = input.task.worktree_path.clone();
        match input.task.kind {
            RequirementTaskKind::BranchMerge | RequirementTaskKind::MergeReview => {
                commit_task_changes(&input.task, &mut output).await?;
            }
            RequirementTaskKind::Implementation => {
                stage_task_changes(&input.task, &mut output).await?;
            }
            _ => {}
        }
        Ok(output)
    }

    pub async fn ask_project_chat(
        &self,
        input: ProjectChatInput,
        events: Option<ProjectChatEventEmitter>,
    ) -> Result<ProjectChatOutput, AppError> {
        let session_reused = self
            .restore_or_new_session(input.pi_session_file.as_deref())
            .await?;
        self.prepare_model_tier(&input.model_settings, RequirementModelTier::Medium)
            .await?;
        self.prompt_with_images(
            &crate::chat::build_project_chat_prompt(&input, session_reused),
            &input.prompt_images,
        )
        .await?;
        let mut pi_events = Vec::new();
        let no_requirement_events = None;
        self.wait_for_agent_end_with_events(
            Duration::from_secs(120),
            Duration::from_secs(600),
            &no_requirement_events,
            |event| {
                if let Some(emitter) = &events {
                    emitter.emit_pi_event(event.clone());
                }
                pi_events.push(event);
            },
        )
        .await?;
        let response = self
            .extract_pi_response(&pi_events)
            .await
            .map_err(pi_response_failure_error)?;
        Ok(ProjectChatOutput {
            assistant_message: response.assistant_text,
            pi_session_file: self.get_session_file().await?,
            trace: response.trace,
        })
    }

    pub async fn clone_requirement_branch(
        &self,
        input: &ProjectChatInput,
    ) -> Result<String, AppError> {
        let main_session = input
            .pi_session_file
            .as_deref()
            .ok_or_else(|| AppError::bad_request("普通会话尚未创建 Pi session"))?;
        if !self.restore_or_new_session(Some(main_session)).await? {
            return Err(AppError::conflict("普通会话 session 不可用于创建需求分支"));
        }
        let main_path = self.resolve_session_path(main_session)?;
        let clone_result = async {
            let response = self
                .send_command(serde_json::json!({ "type": "clone" }))
                .await?;
            if response
                .pointer("/data/cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Err(AppError::conflict("Pi 取消了需求分支创建"));
            }
            let branch = self
                .get_session_file()
                .await?
                .ok_or_else(|| AppError::internal("Pi 未返回需求分支 session"))?;
            self.validate_session_working_dir().await?;
            Ok(branch)
        }
        .await;
        let restore_result = self.switch_session(path_str(&main_path)?).await;
        match (clone_result, restore_result) {
            (Ok(branch), Ok(())) => Ok(branch),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(AppError::internal(format!(
                "需求分支已创建，但切回普通会话失败：{error}"
            ))),
        }
    }

    pub async fn sync_requirement_summary(
        &self,
        input: ProjectChatSummarySyncInput,
    ) -> Result<ProjectChatSummarySyncOutput, AppError> {
        self.restore_or_new_session(input.pi_session_file.as_deref())
            .await?;
        self.prepare_model_tier(&input.model_settings, RequirementModelTier::Medium)
            .await?;
        let criteria = input
            .draft
            .acceptance_criteria
            .iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n");
        let prompt = format!(
            "下面的需求已经在独立分支中完成澄清并确认。请把它作为后续项目问答的已知上下文。不要调用工具，只需简短确认已记录。\n\n# {}\n\n{}\n\n## 验收标准\n\n{}",
            input.draft.title, input.draft.summary, criteria
        );
        self.prompt_with_images(&prompt, &[]).await?;
        let no_requirement_events = None;
        self.wait_for_agent_end_with_events(
            Duration::from_secs(120),
            Duration::from_secs(600),
            &no_requirement_events,
            |_| {},
        )
        .await?;
        Ok(ProjectChatSummarySyncOutput {
            pi_session_file: self.get_session_file().await?,
        })
    }

    pub async fn generate_project_requirement_summary(
        &self,
        input: ProjectChatInput,
        events: Option<ProjectChatEventEmitter>,
    ) -> Result<ProjectRequirementSummaryOutput, AppError> {
        let session_reused = self
            .restore_or_new_session(input.pi_session_file.as_deref())
            .await?;
        self.ensure_project_requirement_summary_extension().await?;
        self.prepare_model_tier(&input.model_settings, RequirementModelTier::Medium)
            .await?;
        let prompt = build_project_requirement_summary_prompt(&input, session_reused);
        self.prompt_with_images(&prompt, &[]).await?;
        let mut pi_events = Vec::new();
        let no_requirement_events = None;
        self.wait_for_agent_end_with_events(
            Duration::from_secs(120),
            Duration::from_secs(600),
            &no_requirement_events,
            |event| {
                if let Some(emitter) = &events {
                    emitter.emit_pi_event(event.clone());
                }
                pi_events.push(event);
            },
        )
        .await?;
        let summary = parse_project_requirement_summary(&pi_events)?;
        Ok(ProjectRequirementSummaryOutput {
            summary,
            pi_session_file: self.get_session_file().await?,
            trace: crate::requirement::build_pi_trace_metadata(&pi_events),
        })
    }

    async fn prepare_high_model(&self, model_settings: &ModelSettings) -> Result<(), AppError> {
        self.prepare_model_tier(model_settings, RequirementModelTier::High)
            .await
    }

    async fn prepare_model_tier(
        &self,
        model_settings: &ModelSettings,
        tier: RequirementModelTier,
    ) -> Result<(), AppError> {
        let setting = match tier {
            RequirementModelTier::Low => &model_settings.low,
            RequirementModelTier::Medium => &model_settings.medium,
            RequirementModelTier::High => &model_settings.high,
        };
        self.prepare_model_setting(setting, tier).await
    }

    async fn prepare_model_setting(
        &self,
        setting: &ModelTierSetting,
        tier: RequirementModelTier,
    ) -> Result<(), AppError> {
        let tier_name = match tier {
            RequirementModelTier::Low => "低档",
            RequirementModelTier::Medium => "中档",
            RequirementModelTier::High => "高档",
        };
        let model_id = setting
            .model_id
            .clone()
            .ok_or_else(|| AppError::bad_request(format!("请先在模型设置中配置{tier_name}模型")))?;
        let models = self.get_available_models().await?;
        let model = models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| {
                AppError::bad_request(format!("{tier_name}模型不存在于 Pi Agent 已配置模型列表"))
            })?;
        self.set_model(&model.provider, &model.id).await?;
        self.set_thinking_level(setting.thinking_level.as_str())
            .await?;
        Ok(())
    }

    async fn set_model(&self, provider: &str, model_id: &str) -> Result<(), AppError> {
        self.send_command(serde_json::json!({
            "type": "set_model",
            "provider": provider,
            "modelId": model_id
        }))
        .await?;
        Ok(())
    }

    async fn set_thinking_level(&self, level: &str) -> Result<(), AppError> {
        self.send_command(serde_json::json!({
            "type": "set_thinking_level",
            "level": level
        }))
        .await?;
        Ok(())
    }

    async fn new_session(&self) -> Result<(), AppError> {
        self.send_command(serde_json::json!({ "type": "new_session" }))
            .await?;
        Ok(())
    }

    async fn restore_or_new_session(&self, session_file: Option<&str>) -> Result<bool, AppError> {
        if self.no_session {
            // --no-session mode: Pi Agent starts fresh; no session commands needed.
            return Ok(false);
        }
        if let Some(session_file) = session_file {
            let session_path = self.resolve_session_path(session_file)?;
            if tokio::fs::try_exists(&session_path).await? {
                let mut header = String::new();
                BufReader::new(tokio::fs::File::open(&session_path).await?)
                    .read_line(&mut header)
                    .await?;
                if session_header_matches_working_dir(&header, &self.working_dir) {
                    self.switch_session(path_str(&session_path)?).await?;
                    return Ok(true);
                }
                tracing::warn!(
                    session_file,
                    expected_cwd = %self.working_dir.display(),
                    "Pi Agent 会话工作目录不匹配，将创建新会话"
                );
                self.new_session().await?;
                return Ok(false);
            }
            tracing::warn!(
                session_file,
                "Pi Agent 会话文件不存在，将使用现有任务摘要创建新会话"
            );
        }
        self.new_session().await?;
        Ok(false)
    }

    async fn switch_session(&self, session_path: &str) -> Result<(), AppError> {
        self.send_command(serde_json::json!({
            "type": "switch_session",
            "sessionPath": session_path
        }))
        .await?;
        Ok(())
    }

    async fn prompt(&self, message: &str) -> Result<(), AppError> {
        self.prompt_with_images(message, &[]).await
    }

    async fn prompt_with_images(
        &self,
        message: &str,
        images: &[PromptImage],
    ) -> Result<(), AppError> {
        let mut command = serde_json::json!({
            "type": "prompt",
            "message": message
        });
        if !images.is_empty() {
            command["images"] = serde_json::json!(
                images
                    .iter()
                    .map(|image| serde_json::json!({
                        "type": "image",
                        "data": image.data_base64.as_str(),
                        "mimeType": image.mime_type.as_str(),
                    }))
                    .collect::<Vec<_>>()
            );
        }
        self.send_command(command).await?;
        Ok(())
    }

    fn resolve_session_path(&self, session_file: &str) -> Result<PathBuf, AppError> {
        let path = Path::new(session_file);
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.session_dir.join(path)
        };
        let resolved = normalize_local_path(&resolved)?;
        ensure_child_path(&self.session_dir, &resolved)?;
        Ok(resolved)
    }

    async fn validate_session_working_dir(&self) -> Result<(), AppError> {
        if self.no_session {
            return Ok(());
        }
        let session_file = self
            .get_session_file()
            .await?
            .ok_or_else(|| AppError::internal("Pi Agent 未返回会话文件"))?;
        let session_path = self.resolve_session_path(&session_file)?;
        let mut first_line = String::new();
        for _ in 0..20 {
            match tokio::fs::File::open(&session_path).await {
                Ok(file) => {
                    let mut reader = BufReader::new(file);
                    reader.read_line(&mut first_line).await?;
                    break;
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
        if first_line.is_empty() {
            return Err(AppError::internal("Pi Agent 会话文件未及时创建"));
        }
        let actual = parse_session_header_cwd(&first_line)?;
        if !same_path(&actual, &self.working_dir) {
            return Err(AppError::internal(format!(
                "Pi Agent 工作目录错误：期望 {}，实际 {}",
                self.working_dir.display(),
                actual.display()
            )));
        }
        Ok(())
    }

    async fn get_last_assistant_text(&self) -> Result<Option<String>, AppError> {
        let response = self
            .send_command(serde_json::json!({ "type": "get_last_assistant_text" }))
            .await?;
        Ok(response
            .get("data")
            .and_then(|data| data.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    async fn get_session_file(&self) -> Result<Option<String>, AppError> {
        let response = self
            .send_command(serde_json::json!({ "type": "get_state" }))
            .await?;
        Ok(response
            .get("data")
            .and_then(|data| data.get("sessionFile"))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    async fn get_session_stats(&self) -> Result<Value, AppError> {
        let response = self
            .send_command(serde_json::json!({ "type": "get_session_stats" }))
            .await?;
        Ok(response.get("data").cloned().unwrap_or(Value::Null))
    }

    async fn attach_session_usage(
        &self,
        trace: Option<Value>,
        session_reused: bool,
    ) -> Option<Value> {
        let stats = match self.get_session_stats().await {
            Ok(stats) => stats,
            Err(error) => {
                tracing::warn!("读取 Pi Agent 会话统计失败：{error}");
                return trace;
            }
        };
        attach_session_usage(trace, &stats, session_reused)
    }

    async fn extract_pi_response(
        &self,
        events: &[Value],
    ) -> Result<crate::requirement::PiResponseExtraction, PiResponseFailure> {
        let last_assistant_text =
            self.get_last_assistant_text()
                .await
                .map_err(|error| PiResponseFailure {
                    message: error.to_string(),
                    trace: crate::requirement::build_pi_trace_metadata(events),
                })?;
        extract_pi_response(events, last_assistant_text)
    }

    async fn prompt_and_extract_response(
        &self,
        prompt: &str,
        warning_after: Duration,
        idle_timeout: Duration,
        events: &Option<RequirementEventEmitter>,
        session_reused: bool,
    ) -> Result<crate::requirement::PiResponseExtraction, AppError> {
        self.prompt(prompt).await?;
        let mut pi_events = Vec::new();
        self.wait_for_agent_end_with_events(warning_after, idle_timeout, events, |event| {
            if let Some(emitter) = events {
                emitter.emit_pi_event(event.clone());
            }
            pi_events.push(event);
        })
        .await?;
        let mut response = self
            .extract_pi_response(&pi_events)
            .await
            .map_err(pi_response_failure_error)?;
        response.trace = self
            .attach_session_usage(response.trace, session_reused)
            .await;
        Ok(response)
    }

    async fn wait_for_agent_end_with_events<F>(
        &self,
        warning_after: Duration,
        hard_timeout: Duration,
        events: &Option<RequirementEventEmitter>,
        mut on_event: F,
    ) -> Result<(), AppError>
    where
        F: FnMut(Value) + Send,
    {
        let mut io = self.io.lock().await;
        let mut line = String::new();
        let mut last_output_at = Instant::now();
        let mut warned = false;
        let cancelled = io.cancelled.clone();

        loop {
            if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = io.child.start_kill();
                return Err(AppError::internal("分析已被用户取消"));
            }

            let idle_for = last_output_at.elapsed();
            if !warned && idle_for > warning_after {
                warned = true;
                if let Some(emitter) = &events {
                    emitter.emit(
                        "coordinator_time_warning",
                        "Pi Agent 已较长时间没有产生新输出，可取消或等待自动重试",
                    );
                }
            }

            line.clear();
            let remaining = hard_timeout.saturating_sub(idle_for);
            tokio::select! {
                read = io.stdout.read_line(&mut line) => {
                    let read = read?;
                    if read == 0 {
                        let _ = io.child.start_kill();
                        return Err(AppError::internal("Pi Agent RPC 已退出"));
                    }
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let value: Value = serde_json::from_str(trimmed)?;
                    if value.get("type") == Some(&serde_json::json!("response")) {
                        continue;
                    }

                    let has_activity = event_has_output_activity(&value);
                    let terminal = is_terminal_agent_end(&value);
                    on_event(value);
                    if has_activity {
                        last_output_at = Instant::now();
                        warned = false;
                    }
                    if terminal {
                        break;
                    }
                }
                _ = tokio::time::sleep(remaining) => {
                    let _ = io.child.start_kill();
                    return Err(AppError::internal("等待 Pi Agent 新输出空闲超时"));
                }
                _ = self.cancel_notify.notified() => {
                    let _ = io.child.start_kill();
                    return Err(AppError::internal("分析已被用户取消"));
                }
            }
        }

        drop(io);
        self.validate_session_working_dir().await
    }

    async fn send_command(&self, mut command: Value) -> Result<Value, AppError> {
        let request_id = format!(
            "raccoon-node-{}",
            PI_RPC_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        command["id"] = serde_json::json!(&request_id);

        let mut io = self.io.lock().await;
        let mut stdin = self.stdin.lock().await;
        // Per-request timeout: 30s for all Pi RPC commands.
        let request_id_for_log = request_id.clone();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            Self::send_command_inner(&mut stdin, &mut io, request_id, command),
        )
        .await;

        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(error),
            Err(_timeout) => {
                // Timed out — kill the child so the caller (or heartbeat) can restart.
                let _ = io.child.start_kill();
                tracing::error!("Pi Agent RPC request {request_id_for_log} timed out after 30s");
                Err(AppError::internal("Pi Agent RPC 请求超时"))
            }
        }
    }

    /// Inner write + read-response loop. Called with `io` already locked.
    async fn send_command_inner(
        stdin: &mut ChildStdin,
        io: &mut PiRpcIo,
        request_id: String,
        command: Value,
    ) -> Result<Value, AppError> {
        stdin.write_all(command.to_string().as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;

        let mut line = String::new();
        loop {
            line.clear();
            let read = io.stdout.read_line(&mut line).await?;
            if read == 0 {
                return Err(AppError::internal("Pi Agent RPC 已退出"));
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let value: Value = serde_json::from_str(trimmed)?;
            if value.get("type") != Some(&serde_json::json!("response")) {
                continue;
            }
            if value.get("id").and_then(Value::as_str) != Some(request_id.as_str()) {
                continue;
            }
            if value.get("success") == Some(&serde_json::json!(false)) {
                let message = value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Pi Agent RPC 请求失败");
                return Err(AppError::internal(message));
            }
            return Ok(value);
        }
    }

    pub async fn send_extension_ui_response(
        &self,
        request_id: &str,
        value: Value,
    ) -> Result<(), AppError> {
        let response = serde_json::json!({
            "type": "extension_ui_response",
            "id": request_id,
            "value": value,
        });
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(response.to_string().as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn drain_startup_noise(&self) -> Result<(), AppError> {
        let mut io = self.io.lock().await;
        let mut line = String::new();
        loop {
            line.clear();
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                io.stdout.read_line(&mut line),
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

    /// Cancel the current Pi Agent operation (e.g., analysis).
    /// Sets the cancellation flag and kills the child process.
    pub async fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.cancel_notify.notify_waiters();
        let mut io = self.io.lock().await;
        let _ = io.child.start_kill();
        let _ = io.child.wait().await;
    }

    /// Check whether this client has been cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::Relaxed)
    }

    async fn shutdown(&self) {
        let mut io = self.io.lock().await;
        let _ = io.child.start_kill();
        let _ = io.child.wait().await;
    }
}

use crate::utils::git;

fn build_project_requirement_summary_prompt(
    input: &ProjectChatInput,
    session_reused: bool,
) -> String {
    let history = if session_reused {
        String::new()
    } else {
        input
            .messages
            .iter()
            .map(|message| {
                let role = match message.role {
                    crate::models::ProjectChatMessageRole::User => "用户",
                    crate::models::ProjectChatMessageRole::Assistant => "助手",
                    crate::models::ProjectChatMessageRole::System => "系统",
                };
                format!("{role}: {}", message.content.trim())
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "请基于当前项目问答的完整上下文生成可继续进入需求澄清的需求说明。必须且只能调用一次 submit_project_requirement_summary；不要调用其他受管工具，也不要只输出文本。{}",
        if history.is_empty() {
            String::new()
        } else {
            format!("\n\nSQLite 问答历史：\n{history}")
        }
    )
}

fn parse_project_requirement_summary(
    events: &[Value],
) -> Result<crate::models::ProjectRequirementSummary, AppError> {
    let results = events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("tool_execution_end")
                && event.get("isError").and_then(Value::as_bool) != Some(true)
                && event.get("toolName").and_then(Value::as_str)
                    == Some("submit_project_requirement_summary")
        })
        .collect::<Vec<_>>();
    if results.len() != 1 {
        return Err(AppError::internal(format!(
            "需求说明必须提交一次受管工具结果，实际为 {} 次",
            results.len()
        )));
    }
    let details = results[0]
        .pointer("/result/details")
        .ok_or_else(|| AppError::internal("需求说明工具结果缺少 details"))?;
    if details.get("protocol").and_then(Value::as_str)
        != Some("raccoon:project-requirement-summary:v1")
    {
        return Err(AppError::internal("需求说明工具协议版本不匹配"));
    }
    let summary: crate::models::ProjectRequirementSummary = serde_json::from_value(
        details
            .get("summary")
            .cloned()
            .ok_or_else(|| AppError::internal("需求说明工具结果缺少 summary"))?,
    )?;
    if summary.title.trim().is_empty()
        || summary.summary.trim().is_empty()
        || summary.acceptance_criteria.is_empty()
        || summary
            .acceptance_criteria
            .iter()
            .any(|item| item.trim().is_empty())
    {
        return Err(AppError::internal("需求说明字段不能为空"));
    }
    Ok(summary)
}

fn is_terminal_agent_end(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("agent_end")
        && event.get("willRetry").and_then(Value::as_bool) != Some(true)
}

fn event_has_output_activity(event: &Value) -> bool {
    if event.get("type") == Some(&serde_json::json!("response")) {
        return false;
    }
    match event.get("type").and_then(Value::as_str) {
        Some("message_update") => event
            .get("assistantMessageEvent")
            .is_some_and(value_has_non_empty_text),
        Some("text_delta")
        | Some("content_delta")
        | Some("message_delta")
        | Some("thinking_delta") => value_has_non_empty_text(event),
        Some("tool_execution_update") | Some("tool_execution_end") => {
            ["partialResult", "partial_result", "result", "output"]
                .iter()
                .any(|key| event.get(*key).is_some_and(value_has_non_empty_text))
        }
        _ => false,
    }
}

fn value_has_non_empty_text(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => items.iter().any(value_has_non_empty_text),
        Value::Object(map) => {
            for key in [
                "delta",
                "text",
                "content",
                "partialResult",
                "partial_result",
                "result",
                "output",
            ] {
                if map.get(key).is_some_and(value_has_non_empty_text) {
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

fn attach_session_usage(
    mut trace: Option<Value>,
    stats: &Value,
    session_reused: bool,
) -> Option<Value> {
    let trace_data = trace.as_mut()?.get_mut("trace")?.as_object_mut()?;
    let tokens = stats.get("tokens").unwrap_or(&Value::Null);
    let context = stats.get("contextUsage").unwrap_or(&Value::Null);
    let input = tokens.get("input").and_then(Value::as_u64).unwrap_or(0);
    let output = tokens.get("output").and_then(Value::as_u64).unwrap_or(0);
    let cache_read = tokens.get("cacheRead").and_then(Value::as_u64).unwrap_or(0);
    let cache_write = tokens
        .get("cacheWrite")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    trace_data.insert(
        "usage".to_owned(),
        serde_json::json!({
            "sessionReused": session_reused,
            "callCount": stats.get("assistantMessages").and_then(Value::as_u64).unwrap_or(0),
            "input": input,
            "output": output,
            "cacheRead": cache_read,
            "cacheWrite": cache_write,
            "context": {
                "tokens": context.get("tokens").and_then(Value::as_u64).unwrap_or(0),
                "window": context.get("contextWindow").and_then(Value::as_u64).unwrap_or(0),
                "percent": context.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
            },
        }),
    );
    trace
}

fn pi_response_failure_error(failure: PiResponseFailure) -> AppError {
    let trace_summary = failure
        .trace
        .as_ref()
        .map(trace_summary)
        .unwrap_or_else(|| "none".to_owned());
    tracing::error!(
        error = %failure.message,
        trace_summary = %trace_summary,
        "Pi Agent RPC returned a failed run"
    );
    if let Some(trace) = &failure.trace {
        tracing::debug!(error = %failure.message, trace = %trace, "Pi Agent RPC failed trace");
    }
    AppError::internal(failure.message)
}

fn trace_summary(trace: &Value) -> String {
    let trace_obj = match trace.get("trace") {
        Some(Value::Object(obj)) => obj,
        _ => return "malformed".to_owned(),
    };
    let status_count = trace_obj
        .get("statuses")
        .and_then(Value::as_array)
        .map(|statuses| statuses.len())
        .unwrap_or(0);
    let last_status = trace_obj
        .get("statuses")
        .and_then(Value::as_array)
        .and_then(|statuses| statuses.last())
        .and_then(|status| status.get("message").and_then(Value::as_str))
        .unwrap_or("");
    let truncated = if last_status.chars().count() > 80 {
        format!("{}...", last_status.chars().take(80).collect::<String>())
    } else {
        last_status.to_owned()
    };
    format!("statuses={status_count} last=\"{truncated}\"")
}

async fn prepare_task_workspace(
    data_root: &Path,
    input: &RequirementTaskExecutionInput,
) -> Result<(PathBuf, Option<String>, Option<PathBuf>), AppError> {
    match input.task.kind {
        RequirementTaskKind::Review
        | RequirementTaskKind::ReviewSubAgent
        | RequirementTaskKind::ReviewSummary => {
            let review_for = input
                .task
                .review_for
                .as_deref()
                .ok_or_else(|| AppError::bad_request("审核节点缺少 review_for"))?;
            let reviewed = input
                .plan
                .tasks
                .iter()
                .find(|task| task.id == review_for)
                .ok_or_else(|| AppError::bad_request("审核目标不存在"))?;
            let worktree = reviewed
                .worktree_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(&input.project.local_path));
            let worktree = resolve_project_working_dir(data_root, &worktree.to_string_lossy())?;
            Ok((worktree, None, None))
        }
        RequirementTaskKind::Implementation
        | RequirementTaskKind::BranchMerge
        | RequirementTaskKind::MergeReview => {
            let repo = resolve_project_working_dir(data_root, &input.project.local_path)?;
            let branch = input
                .task
                .branch_name
                .clone()
                .unwrap_or_else(|| task_branch_name(&input.requirement.id, &input.task.id));
            let worktree = input
                .task
                .worktree_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    task_worktree_path(data_root, &input.requirement.id, &input.task.id)
                });
            let worktree = normalize_local_path(&worktree)?;
            ensure_child_path(&data_root.join("worktrees"), &worktree)?;

            let existed = worktree.join(".git").exists();
            let recovering = input.task.worktree_path.is_some() || input.task.branch_name.is_some();
            if recovering && !existed {
                return Err(AppError::internal("恢复节点失败：worktree 不存在"));
            }
            if let Some(existing_branch) = input.task.branch_name.as_deref() {
                ensure_branch_exists(&repo, existing_branch).await?;
            }
            if !existed {
                if let Some(parent) = worktree.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                let dependency_branches = task_dependency_branches(input);
                let base_ref = dependency_branches
                    .first()
                    .map(String::as_str)
                    .unwrap_or("HEAD");
                git(
                    &repo,
                    &[
                        "worktree",
                        "add",
                        "-B",
                        &branch,
                        path_str(&worktree)?,
                        base_ref,
                    ],
                )
                .await?;
                merge_dependency_branches(&worktree, dependency_branches.into_iter().skip(1))
                    .await?;
            }
            Ok((worktree.clone(), Some(branch), Some(worktree)))
        }
    }
}

async fn ensure_branch_exists(repo: &Path, branch: &str) -> Result<(), AppError> {
    git(repo, &["rev-parse", "--verify", branch])
        .await
        .map(|_| ())
        .map_err(|_| AppError::internal(format!("恢复节点失败：分支 {branch} 不存在")))
}

fn task_dependency_branches(input: &RequirementTaskExecutionInput) -> Vec<String> {
    dependency_branches_for_task(&input.task, &input.plan)
}

fn dependency_branches_for_task(
    task: &crate::models::RequirementExecutionTask,
    plan: &crate::models::RequirementExecutionPlan,
) -> Vec<String> {
    match task.kind {
        RequirementTaskKind::Implementation
        | RequirementTaskKind::BranchMerge
        | RequirementTaskKind::MergeReview => task
            .depends_on
            .iter()
            .filter_map(|dependency| {
                plan.tasks
                    .iter()
                    .find(|task| task.id == *dependency)
                    .and_then(|task| task.branch_name.clone())
            })
            .collect(),
        RequirementTaskKind::Review
        | RequirementTaskKind::ReviewSubAgent
        | RequirementTaskKind::ReviewSummary => Vec::new(),
    }
}

async fn merge_dependency_branches(
    worktree: &Path,
    branches: impl Iterator<Item = String>,
) -> Result<(), AppError> {
    for branch in branches {
        git(worktree, &["merge", "--no-ff", "--no-edit", &branch]).await?;
    }
    Ok(())
}

pub(crate) async fn stage_task_changes(
    task: &crate::models::RequirementExecutionTask,
    output: &mut RequirementTaskExecutionOutput,
) -> Result<(), AppError> {
    let worktree = task
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::internal("执行节点缺少 worktree_path"))?;
    let status = git(&worktree, &["status", "--porcelain"]).await?;
    if !status.trim().is_empty() {
        git(&worktree, &["add", "-A"]).await?;
        return Ok(());
    }

    if task.status == crate::models::RequirementTaskStatus::Fixing {
        return Err(AppError::internal("修复实现节点必须产生实际代码改动"));
    }

    let no_op_reason = output
        .no_op_reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty());
    if output.changed == Some(false) {
        if let Some(reason) = no_op_reason {
            output.execution_warning =
                Some(format!("未产生新改动：{reason}。按 no-op 完成并进入审核。"));
            return Ok(());
        }
        return Err(AppError::internal(
            "实现节点未产生改动，且缺少 no_op_reason",
        ));
    }

    Err(AppError::internal("实现节点没有产生可提交改动"))
}

async fn commit_task_changes(
    task: &crate::models::RequirementExecutionTask,
    _output: &mut RequirementTaskExecutionOutput,
) -> Result<(), AppError> {
    let worktree = task
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::internal("执行节点缺少 worktree_path"))?;
    let status = git(&worktree, &["status", "--porcelain"]).await?;
    if !status.trim().is_empty() {
        git(&worktree, &["add", "-A"]).await?;
        let message = format!("raccoon_node: {}", task.title);
        git(&worktree, &["commit", "-m", &message]).await?;
    }
    Ok(())
}

struct PublishResult {
    pull_request_url: Option<String>,
    merged_into: String,
    cleanup_summary: String,
}

async fn publish_merge_review(
    data_root: &Path,
    input: &RequirementTaskExecutionInput,
    output: &RequirementTaskExecutionOutput,
) -> Result<PublishResult, AppError> {
    let repo = resolve_project_working_dir(data_root, &input.project.local_path)?;
    let branch = output
        .branch_name
        .as_deref()
        .ok_or_else(|| AppError::internal("最终合并节点缺少分支名"))?;
    let worktree = input
        .task
        .worktree_path
        .as_deref()
        .ok_or_else(|| AppError::internal("最终合并节点缺少 worktree_path"))?;
    let worktree = resolve_project_working_dir(data_root, worktree)?;
    let provider = remote_provider(&repo).await;
    let (pull_request_url, base_branch) = match provider {
        GitProvider::Local => {
            let base_branch = local_merge_base(&repo).await?;
            merge_local_branch(&repo, branch).await?;
            (None, base_branch)
        }
        GitProvider::GitHub => {
            let commit = git(&worktree, &["rev-parse", "HEAD"])
                .await?
                .trim()
                .to_owned();
            let base_branch = default_branch(&repo).await?;
            git(&repo, &["push", "-u", "origin", branch]).await?;
            let pr_url = ensure_pull_request(&repo, &base_branch, branch, input).await?;
            if !pull_request_is_merged(&repo, &pr_url).await {
                let merge_args = build_pr_merge_args(&pr_url, &commit);
                run_gh(
                    &repo,
                    &merge_args.iter().map(String::as_str).collect::<Vec<_>>(),
                )
                .await?;
            }
            sync_checked_out_remote_base(&repo, &base_branch).await?;
            (Some(pr_url), base_branch)
        }
        GitProvider::GitLab => {
            let commit = git(&worktree, &["rev-parse", "HEAD"])
                .await?
                .trim()
                .to_owned();
            let base_branch = default_branch(&repo).await?;
            git(&repo, &["push", "-u", "origin", branch]).await?;
            let mr_url = ensure_merge_request(&repo, &base_branch, branch, input).await?;
            if !merge_request_is_merged(&repo, branch).await {
                let merge_args = build_gitlab_mr_merge_args(branch, &commit);
                run_glab(
                    &repo,
                    &merge_args.iter().map(String::as_str).collect::<Vec<_>>(),
                )
                .await?;
            }
            sync_checked_out_remote_base(&repo, &base_branch).await?;
            (Some(mr_url), base_branch)
        }
    };
    let cleanup_summary =
        cleanup_requirement_branches(data_root, &repo, input, provider != GitProvider::Local).await;

    Ok(PublishResult {
        pull_request_url,
        merged_into: base_branch,
        cleanup_summary,
    })
}

async fn remote_provider(repo: &Path) -> GitProvider {
    match git(repo, &["remote", "get-url", "origin"]).await {
        Ok(url) => GitProvider::from_origin(url.trim()),
        Err(_) => GitProvider::Local,
    }
}

#[cfg(test)]
async fn repository_has_origin(repo: &Path) -> bool {
    git(repo, &["remote", "get-url", "origin"])
        .await
        .is_ok_and(|url| !url.trim().is_empty())
}

async fn local_merge_base(repo: &Path) -> Result<String, AppError> {
    let branch = git(repo, &["symbolic-ref", "--short", "HEAD"])
        .await
        .map_err(|_| AppError::internal("本地合并失败：项目根工作区处于 detached HEAD"))?;
    let status = git(repo, &["status", "--porcelain"]).await?;
    if !status.trim().is_empty() {
        return Err(AppError::internal(
            "本地合并失败：项目根工作区存在未提交改动",
        ));
    }
    Ok(branch.trim().to_owned())
}

async fn merge_local_branch(repo: &Path, branch: &str) -> Result<(), AppError> {
    if let Err(error) = git(repo, &["merge", "--no-ff", "--no-edit", branch]).await {
        let _ = git(repo, &["merge", "--abort"]).await;
        return Err(error);
    }
    Ok(())
}

async fn sync_checked_out_remote_base(repo: &Path, base_branch: &str) -> Result<(), AppError> {
    git(repo, &["fetch", "origin"]).await?;
    let Ok(current_branch) = git(repo, &["symbolic-ref", "--short", "HEAD"]).await else {
        return Ok(());
    };
    if current_branch.trim() != base_branch {
        return Ok(());
    }
    let status = git(repo, &["status", "--porcelain"]).await?;
    if !status.trim().is_empty() {
        return Err(AppError::internal(
            "PR 已合并，但本地目标分支存在未提交改动，无法安全同步",
        ));
    }
    git(
        repo,
        &["merge", "--ff-only", &format!("origin/{base_branch}")],
    )
    .await?;
    Ok(())
}

async fn default_branch(repo: &Path) -> Result<String, AppError> {
    let cached = git(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .await
    .unwrap_or_default();
    if !cached.trim().is_empty() {
        return Ok(parse_default_branch(&cached));
    }
    let remote = git(repo, &["ls-remote", "--symref", "origin", "HEAD"]).await?;
    parse_remote_default_branch(&remote)
        .ok_or_else(|| AppError::internal("无法确定 origin 的默认分支"))
}

fn parse_default_branch(output: &str) -> String {
    let branch = output
        .trim()
        .strip_prefix("origin/")
        .unwrap_or(output.trim())
        .trim();
    if branch.is_empty() {
        "main".to_owned()
    } else {
        branch.to_owned()
    }
}

fn parse_remote_default_branch(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.strip_prefix("ref: refs/heads/")
            .and_then(|line| line.strip_suffix("\tHEAD"))
            .map(str::to_owned)
    })
}

async fn ensure_pull_request(
    repo: &Path,
    base_branch: &str,
    branch: &str,
    input: &RequirementTaskExecutionInput,
) -> Result<String, AppError> {
    if let Ok(url) = run_gh(
        repo,
        &["pr", "view", branch, "--json", "url", "--jq", ".url"],
    )
    .await
    {
        let url = url.trim();
        if !url.is_empty() {
            return Ok(url.to_owned());
        }
    }

    let title = format!("raccoon_node: {}", input.requirement.title);
    let body = format!(
        "自动合并需求：{}\n\n{}",
        input.requirement.title,
        input
            .requirement
            .draft
            .as_ref()
            .map(|draft| draft.summary.as_str())
            .unwrap_or("无摘要")
    );
    let args = [
        "pr",
        "create",
        "--base",
        base_branch,
        "--head",
        branch,
        "--title",
        &title,
        "--body",
        &body,
    ];
    let url = run_gh(repo, &args).await?;
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::internal("gh pr create 未返回 PR 地址"));
    }
    Ok(url.to_owned())
}

async fn pull_request_is_merged(repo: &Path, pr_url: &str) -> bool {
    run_gh(
        repo,
        &["pr", "view", pr_url, "--json", "state", "--jq", ".state"],
    )
    .await
    .is_ok_and(|state| state.trim() == "MERGED")
}

fn build_pr_merge_args(pr_url: &str, commit: &str) -> Vec<String> {
    vec![
        "pr".to_owned(),
        "merge".to_owned(),
        pr_url.to_owned(),
        "--merge".to_owned(),
        "--match-head-commit".to_owned(),
        commit.to_owned(),
    ]
}

async fn ensure_merge_request(
    repo: &Path,
    base_branch: &str,
    branch: &str,
    input: &RequirementTaskExecutionInput,
) -> Result<String, AppError> {
    if let Ok(json) = run_glab(repo, &["mr", "view", branch, "--output=json"]).await
        && let Some(url) = json
            .trim()
            .lines()
            .last()
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            .and_then(|value| {
                value
                    .get("web_url")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
    {
        return Ok(url);
    }

    let title = format!("raccoon_node: {}", input.requirement.title);
    let body = format!(
        "自动合并需求：{}\n\n{}",
        input.requirement.title,
        input
            .requirement
            .draft
            .as_ref()
            .map(|draft| draft.summary.as_str())
            .unwrap_or("无摘要")
    );
    let output = run_glab(
        repo,
        &[
            "mr",
            "create",
            "--target-branch",
            base_branch,
            "--source-branch",
            branch,
            "--title",
            &title,
            "--description",
            &body,
            "--yes",
            "--output=json",
        ],
    )
    .await?;
    let url = output
        .trim()
        .lines()
        .last()
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
        .and_then(|value| {
            value
                .get("web_url")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| AppError::internal("glab mr create 未返回 MR 地址"))?;
    Ok(url)
}

async fn merge_request_is_merged(repo: &Path, branch: &str) -> bool {
    run_glab(repo, &["mr", "view", branch, "--output=json"])
        .await
        .is_ok_and(|json| {
            json.trim()
                .lines()
                .last()
                .and_then(|line| serde_json::from_str::<Value>(line).ok())
                .and_then(|value| {
                    value
                        .get("state")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                == Some("merged".to_owned())
        })
}

fn build_gitlab_mr_merge_args(branch: &str, commit: &str) -> Vec<String> {
    vec![
        "mr".to_owned(),
        "merge".to_owned(),
        branch.to_owned(),
        "--sha".to_owned(),
        commit.to_owned(),
        "--yes".to_owned(),
    ]
}

async fn cleanup_requirement_branches(
    data_root: &Path,
    repo: &Path,
    input: &RequirementTaskExecutionInput,
    delete_remote: bool,
) -> String {
    let branches = generated_branch_names(
        input
            .plan
            .tasks
            .iter()
            .chain(std::iter::once(&input.task))
            .filter_map(|task| task.branch_name.as_deref()),
    );
    let worktrees = input
        .plan
        .tasks
        .iter()
        .chain(std::iter::once(&input.task))
        .filter_map(|task| task.worktree_path.as_deref())
        .map(PathBuf::from)
        .collect::<BTreeSet<_>>();

    let mut removed_worktrees = 0;
    for worktree in worktrees {
        if ensure_child_path(&data_root.join("worktrees"), &worktree).is_ok() && worktree.exists() {
            let Ok(worktree_str) = path_str(&worktree) else {
                continue;
            };
            if git(repo, &["worktree", "remove", "--force", worktree_str])
                .await
                .is_ok()
            {
                removed_worktrees += 1;
            }
        }
    }

    let mut removed_local = 0;
    let mut removed_remote = 0;
    for branch in branches {
        if git(repo, &["branch", "-D", &branch]).await.is_ok() {
            removed_local += 1;
        }
        if delete_remote
            && git(repo, &["push", "origin", "--delete", &branch])
                .await
                .is_ok()
        {
            removed_remote += 1;
        }
    }

    format!(
        "已清理 worktree {removed_worktrees} 个、本地分支 {removed_local} 个、远端分支 {removed_remote} 个"
    )
}

fn generated_branch_names<'a>(branches: impl Iterator<Item = &'a str>) -> BTreeSet<String> {
    branches
        .filter(|branch| branch.starts_with("rn/"))
        .map(ToOwned::to_owned)
        .collect()
}

async fn run_gh(dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let dir = normalize_local_path(dir)?;
    let output = Command::new("gh")
        .args(args)
        .current_dir(&dir)
        .output()
        .await?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::internal(format!(
        "gh {} 失败：{}",
        args.join(" "),
        stderr.trim()
    )))
}

async fn run_glab(dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let dir = normalize_local_path(dir)?;
    let program = if cfg!(windows) { "glab.exe" } else { "glab" };
    let output = Command::new(program)
        .args(args)
        .current_dir(&dir)
        .output()
        .await?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::internal(format!(
        "glab {} 失败：{}",
        args.join(" "),
        stderr.trim()
    )))
}

fn task_branch_name(requirement_id: &str, task_id: &str) -> String {
    format!("rn/{}/{}", slug(requirement_id), slug(task_id))
}

fn task_worktree_path(data_root: &Path, requirement_id: &str, task_id: &str) -> PathBuf {
    data_root
        .join("worktrees")
        .join(safe_worktree_name(&format!("{requirement_id}-{task_id}")))
}

fn safe_worktree_name(value: &str) -> String {
    const MAX_LEN: usize = 80;
    let mut name = slug(value);
    if is_windows_reserved_name(&name) {
        name.insert(0, '_');
    }
    if name.len() <= MAX_LEN {
        return name;
    }
    let hash = value.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("{}-{hash:08x}", &name[..MAX_LEN - 17])
}

fn is_windows_reserved_name(value: &str) -> bool {
    let value = value.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    matches!(value.as_str(), "con" | "prn" | "aux" | "nul")
        || matches!(
            value
                .strip_prefix("com")
                .and_then(|value| value.parse::<u8>().ok()),
            Some(1..=9)
        )
        || matches!(
            value
                .strip_prefix("lpt")
                .and_then(|value| value.parse::<u8>().ok()),
            Some(1..=9)
        )
}

fn slug(value: &str) -> String {
    let slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    if slug.is_empty() {
        "node".to_owned()
    } else {
        slug
    }
}

fn path_str(path: &Path) -> Result<&str, AppError> {
    path.to_str()
        .ok_or_else(|| AppError::internal("路径不是有效 UTF-8"))
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left)
        .ok()
        .and_then(|path| normalize_local_path(&path).ok())
        .unwrap_or_else(|| left.to_path_buf());
    let right = std::fs::canonicalize(right)
        .ok()
        .and_then(|path| normalize_local_path(&path).ok())
        .unwrap_or_else(|| right.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn parse_session_header_cwd(line: &str) -> Result<PathBuf, AppError> {
    if line.len() > 8192 {
        return Err(AppError::internal("Pi Agent 会话头过长"));
    }
    let header: Value = serde_json::from_str(line.trim())?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err(AppError::internal("Pi Agent 会话首行类型错误"));
    }
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("Pi Agent 会话缺少 cwd"))?;
    let cwd = normalize_local_path(Path::new(cwd))?;
    if !cwd.is_absolute() {
        return Err(AppError::internal("Pi Agent 会话 cwd 不是绝对路径"));
    }
    Ok(cwd)
}

fn session_header_matches_working_dir(header: &str, expected: &Path) -> bool {
    parse_session_header_cwd(header).is_ok_and(|actual| same_path(&actual, expected))
}

impl Drop for PiRpcClient {
    fn drop(&mut self) {
        if let Ok(mut io) = self.io.try_lock() {
            let _ = io.child.start_kill();
        }
    }
}
