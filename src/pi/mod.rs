use std::{
    collections::HashSet,
    hash::{Hash, Hasher},
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

mod transport;

use serde::Deserialize;
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};
use transport::PiRpcTransportConfig;

use crate::error::AppError;
use crate::models::{
    ModelProvider, ModelProviderActionFuture, ModelProviderFuture, ModelSettings, ModelTierSetting,
    PI_RPC_REQUEST_ID, PiModel, ProjectChatBranchFuture, ProjectChatEventEmitter,
    ProjectChatFuture, ProjectChatInput, ProjectChatOutput, PromptImage, RequirementAnalysisFuture,
    RequirementAnalysisInput, RequirementAnalysisOutput, RequirementEventEmitter,
    RequirementFailureStage, RequirementModelTier, RequirementStatus, WorkflowAttemptFuture,
    WorkflowPlanFuture, WorkflowReviewFuture,
};
use crate::prompt::attach_prompt_diagnostics;
use crate::requirement::{
    PiResponseFailure, build_requirement_prompt, extract_pi_response,
    format_requirement_evidence_index, parse_requirement_tool_analysis,
};
use crate::utils::{ensure_child_path, normalize_local_path, resolve_git_root};
use crate::workflow::{
    FindingPriority, FindingStatus, WorkflowAgentInput, WorkflowAgentOutput, WorkflowAttemptKind,
    WorkflowPlanInput, WorkflowPlanOutput, WorkflowReviewFinding, WorkflowReviewInput,
    WorkflowReviewOutput, build_workflow_attempt_prompt, build_workflow_plan_prompt,
    build_workflow_review_prompt, change_spec_from_requirement, compile_work_plan,
    parse_review_angle, validate_change_spec,
};

static PI_OPERATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const CLARIFICATION_EXTENSION: &str = include_str!("assets/raccoon-clarification.mjs");
const REVIEW_ORCHESTRATOR_EXTENSION: &str = include_str!("assets/raccoon-review-orchestrator.mjs");
const REVIEW_WORKER_EXTENSION: &str = include_str!("assets/raccoon-review-worker.mjs");
const TASK_RUNTIME_EXTENSION: &str = include_str!("assets/raccoon-task-runtime.mjs");

const PROJECT_CHAT_TOOLS: &str = "read,bash,grep,find,ls";
const REQUIREMENT_ANALYSIS_TOOLS: &str =
    "read,bash,grep,find,ls,request_clarifications,submit_change_spec";
const WORK_PLAN_TOOLS: &str = "read,bash,grep,find,ls,submit_work_plan";
const WORK_ITEM_TOOLS: &str = "read,bash,edit,write,grep,find,ls,submit_workflow_result";
const OPERATION_WARNING_SECONDS: u64 = 120;
const OPERATION_IDLE_TIMEOUT_SECONDS: u64 = 600;

#[derive(Debug, Clone)]
struct OperationRuntimeObservation {
    warning_after: Duration,
    idle_timeout: Duration,
    input_budget: Option<u64>,
    observed_input: u64,
    budget_warning_emitted: bool,
    idle_warning_count: u64,
    activity_count: u64,
    max_idle: Duration,
    termination_reason: &'static str,
}

impl OperationRuntimeObservation {
    fn new(warning_after: Duration, idle_timeout: Duration, input_budget: Option<u64>) -> Self {
        Self {
            warning_after,
            idle_timeout,
            input_budget,
            observed_input: 0,
            budget_warning_emitted: false,
            idle_warning_count: 0,
            activity_count: 0,
            max_idle: Duration::ZERO,
            termination_reason: "running",
        }
    }
}

async fn install_managed_extension(
    data_root: &Path,
    file_name: &str,
    expected: &str,
) -> Result<PathBuf, AppError> {
    let directory = data_root.join("extensions");
    ensure_child_path(data_root, &directory)?;
    tokio::fs::create_dir_all(&directory).await?;
    let path = directory.join(file_name);
    ensure_child_path(&directory, &path)?;
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::bad_request("受管 Pi 插件不能是符号链接"));
    }
    if !matches!(
        tokio::fs::read_to_string(&path).await,
        Ok(content) if content == expected
    ) {
        tokio::fs::write(&path, expected).await?;
    }
    Ok(path)
}

pub struct PiRpcModelProvider {
    pub data_root: PathBuf,
    pub session_dir: PathBuf,
    pub global_client: Arc<tokio::sync::RwLock<Option<Arc<PiRpcClient>>>>,
    pub project_client: tokio::sync::Mutex<Option<(Arc<PiRpcClient>, Instant)>>,
    pub project_chat_client: tokio::sync::Mutex<Option<Arc<PiRpcClient>>>,
    pub project_chat_operation: tokio::sync::Mutex<Option<Arc<AtomicBool>>>,
    pub startup_error: Option<String>,
    /// 0=Ready, 1=Reconnecting, 2=Error
    pub rpc_status: Arc<AtomicU8>,
    clarification_extension_path: Option<PathBuf>,
    review_extension_path: Option<PathBuf>,
    task_runtime_extension_path: Option<PathBuf>,
    clarification_extension_error: Option<String>,
    task_runtime_extension_error: Option<String>,
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
            match install_managed_extension(
                &data_root,
                "raccoon-clarification.mjs",
                CLARIFICATION_EXTENSION,
            )
            .await
            {
                Ok(path) => (Some(path), None),
                Err(error) => (None, Some(error.to_string())),
            };
        let review_extension_path = match install_managed_extension(
            &data_root,
            "raccoon-review-worker.mjs",
            REVIEW_WORKER_EXTENSION,
        )
        .await
        {
            Ok(_) => install_managed_extension(
                &data_root,
                "raccoon-review-orchestrator.mjs",
                REVIEW_ORCHESTRATOR_EXTENSION,
            )
            .await
            .ok(),
            Err(_) => None,
        };
        let (task_runtime_extension_path, task_runtime_extension_error) =
            match install_managed_extension(
                &data_root,
                "raccoon-task-runtime.mjs",
                TASK_RUNTIME_EXTENSION,
            )
            .await
            {
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
            project_client: tokio::sync::Mutex::new(None),
            project_chat_client: tokio::sync::Mutex::new(None),
            project_chat_operation: tokio::sync::Mutex::new(None),
            startup_error,
            rpc_status,
            clarification_extension_path,
            review_extension_path,
            task_runtime_extension_path,
            clarification_extension_error,
            task_runtime_extension_error,
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
        if let Some((client, _)) = self.project_client.lock().await.take() {
            client.shutdown().await;
        }
        if let Some(client) = self.project_chat_client.lock().await.take() {
            client.shutdown().await;
        }
    }

    async fn reload_clients(&self) -> Result<(), AppError> {
        self.rpc_status
            .store(RPC_STATUS_RECONNECTING, Ordering::Relaxed);
        if let Some(client) = self.global_client.write().await.take() {
            client.shutdown().await;
        }
        if let Some((client, _)) = self.project_client.lock().await.take() {
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
        let mut slot = self.project_client.lock().await;
        if let Some((client, last_used)) = slot.as_mut() {
            *last_used = Instant::now();
            return Ok(client.clone());
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
        let task_runtime = self.task_runtime_extension_path.as_deref().ok_or_else(|| {
            AppError::internal(
                self.task_runtime_extension_error
                    .clone()
                    .unwrap_or_else(|| "受管 Pi 任务运行时插件不可用".to_owned()),
            )
        })?;
        let extension_paths = vec![extension_path.to_path_buf(), task_runtime.to_path_buf()];
        let client = PiRpcClient::start_managed(
            &self.session_dir,
            &working_dir,
            &extension_paths,
            REQUIREMENT_ANALYSIS_TOOLS,
            Some("requirement_analysis"),
        )
        .await?;
        let client = Arc::new(client);
        *slot = Some((client.clone(), Instant::now()));
        Ok(client)
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

    fn plan_workflow(
        &self,
        input: WorkflowPlanInput,
        events: Option<RequirementEventEmitter>,
    ) -> WorkflowPlanFuture<'_> {
        Box::pin(async move {
            change_spec_from_requirement(&input.requirement)?;
            let working_dir =
                resolve_project_working_dir(&self.data_root, &input.project.local_path)?;
            let task_runtime = self.task_runtime_extension_path.as_ref().ok_or_else(|| {
                AppError::internal(
                    self.task_runtime_extension_error
                        .clone()
                        .unwrap_or_else(|| "受管 Pi 任务运行时插件不可用".to_owned()),
                )
            })?;
            let client = PiRpcClient::start_managed(
                &self.session_dir,
                &working_dir,
                std::slice::from_ref(task_runtime),
                WORK_PLAN_TOOLS,
                Some("work_plan"),
            )
            .await?;
            let result = client.plan_workflow(input, events).await;
            client.shutdown().await;
            result
        })
    }

    fn execute_workflow_attempt(
        &self,
        input: WorkflowAgentInput,
        events: Option<RequirementEventEmitter>,
    ) -> WorkflowAttemptFuture<'_> {
        Box::pin(async move {
            let task_runtime = self.task_runtime_extension_path.as_ref().ok_or_else(|| {
                AppError::internal(
                    self.task_runtime_extension_error
                        .clone()
                        .unwrap_or_else(|| "受管 Pi 任务运行时插件不可用".to_owned()),
                )
            })?;
            let role = if input.attempt_kind == WorkflowAttemptKind::Rescue {
                "rescue"
            } else {
                "work_item"
            };
            let client = PiRpcClient::start_managed(
                &self.session_dir,
                &input.working_dir,
                std::slice::from_ref(task_runtime),
                WORK_ITEM_TOOLS,
                Some(role),
            )
            .await?;
            let result = client.execute_workflow_attempt(input, events).await;
            client.shutdown().await;
            result
        })
    }

    fn review_workflow_checkpoint(
        &self,
        input: WorkflowReviewInput,
        events: Option<RequirementEventEmitter>,
    ) -> WorkflowReviewFuture<'_> {
        Box::pin(async move {
            let review_extension = self
                .review_extension_path
                .as_ref()
                .ok_or_else(|| AppError::internal("受管 Pi 内存子 Agent 审核插件不可用"))?;
            let client = PiRpcClient::start_managed(
                &self.session_dir,
                &input.working_dir,
                std::slice::from_ref(review_extension),
                "run_parallel_code_review",
                None,
            )
            .await?;
            let result = client.review_workflow_checkpoint(input, events).await;
            client.shutdown().await;
            result
        })
    }

    fn ask_project_chat(
        &self,
        input: ProjectChatInput,
        events: Option<ProjectChatEventEmitter>,
    ) -> ProjectChatFuture<'_> {
        Box::pin(async move {
            let operation = self
                .project_chat_operation
                .lock()
                .await
                .clone()
                .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
            let result = async {
                let working_dir =
                    resolve_project_working_dir(&self.data_root, &input.project.local_path)?;
                let task_runtime = self.task_runtime_extension_path.as_ref().ok_or_else(|| {
                    AppError::internal(
                        self.task_runtime_extension_error
                            .clone()
                            .unwrap_or_else(|| "受管 Pi 任务运行时插件不可用".to_owned()),
                    )
                })?;
                let client = Arc::new(
                    PiRpcClient::start_managed(
                        &self.session_dir,
                        &working_dir,
                        std::slice::from_ref(task_runtime),
                        PROJECT_CHAT_TOOLS,
                        Some("chat"),
                    )
                    .await?,
                );
                *self.project_chat_client.lock().await = Some(client.clone());
                if operation.load(Ordering::Relaxed) {
                    client.cancel().await;
                }
                let output = client.ask_project_chat(input, events).await;
                self.project_chat_client.lock().await.take();
                client.shutdown().await;
                output
            }
            .await;
            self.project_chat_operation.lock().await.take();
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
                let mut operation = self.project_chat_operation.lock().await;
                if operation.is_some() {
                    return Err(AppError::conflict("普通会话正在运行，暂时无法创建需求分支"));
                }
                *operation = Some(Arc::new(AtomicBool::new(false)));
            }
            let result = async {
                let working_dir =
                    resolve_project_working_dir(&self.data_root, &input.project.local_path)?;
                let extension_path = self
                    .clarification_extension_path
                    .as_deref()
                    .ok_or_else(|| AppError::internal("受管需求澄清插件不可用"))?;
                let client = PiRpcClient::start_with_extension(
                    &self.session_dir,
                    &working_dir,
                    extension_path,
                )
                .await?;
                let result = client.clone_requirement_branch(&input).await;
                client.shutdown().await;
                result.map(Some)
            }
            .await;
            self.project_chat_operation.lock().await.take();
            result
        })
    }

    fn begin_project_chat(&self) -> ModelProviderActionFuture<'_> {
        Box::pin(async move {
            let mut operation = self.project_chat_operation.lock().await;
            if operation.is_some() {
                return Err(AppError::conflict("普通会话正在运行"));
            }
            *operation = Some(Arc::new(AtomicBool::new(false)));
            Ok(())
        })
    }

    fn cancel_project_chat(&self) -> ModelProviderActionFuture<'_> {
        Box::pin(async move {
            let operation = self
                .project_chat_operation
                .lock()
                .await
                .clone()
                .ok_or_else(|| AppError::conflict("项目问答当前未运行"))?;
            operation.store(true, Ordering::Relaxed);
            if let Some(client) = self.project_chat_client.lock().await.clone() {
                client.cancel().await;
            }
            Ok(())
        })
    }

    fn release_project(&self) -> ModelProviderActionFuture<'_> {
        Box::pin(async move {
            if let Some((client, _)) = self.project_client.lock().await.take() {
                client.shutdown().await;
            }
            Ok(())
        })
    }

    fn cancel_requirement_analysis(&self) -> ModelProviderActionFuture<'_> {
        Box::pin(async move {
            if let Some((client, _)) = self.project_client.lock().await.take() {
                client.cancel().await;
            }
            Ok(())
        })
    }

    fn respond_requirement_interaction(
        &self,
        request_id: &str,
        response: Value,
    ) -> ModelProviderActionFuture<'_> {
        let request_id = request_id.to_owned();
        Box::pin(async move {
            let client = self
                .project_client
                .lock()
                .await
                .as_ref()
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
        Self::start_with_optional_extensions(session_dir, working_dir, &[], None, None).await
    }

    pub async fn start_with_extension(
        session_dir: &Path,
        working_dir: &Path,
        extension_path: &Path,
    ) -> Result<Self, AppError> {
        Self::start_with_extensions(session_dir, working_dir, &[extension_path.to_path_buf()]).await
    }

    pub async fn start_with_extensions(
        session_dir: &Path,
        working_dir: &Path,
        extension_paths: &[PathBuf],
    ) -> Result<Self, AppError> {
        Self::start_with_optional_extensions(session_dir, working_dir, extension_paths, None, None)
            .await
    }

    pub async fn start_with_extensions_and_tools(
        session_dir: &Path,
        working_dir: &Path,
        extension_paths: &[PathBuf],
        tool_names: &str,
    ) -> Result<Self, AppError> {
        Self::start_with_optional_extensions(
            session_dir,
            working_dir,
            extension_paths,
            Some(tool_names),
            None,
        )
        .await
    }

    pub async fn start_managed(
        session_dir: &Path,
        working_dir: &Path,
        extension_paths: &[PathBuf],
        tool_names: &str,
        workflow_role: Option<&str>,
    ) -> Result<Self, AppError> {
        Self::start_with_optional_extensions(
            session_dir,
            working_dir,
            extension_paths,
            Some(tool_names),
            workflow_role,
        )
        .await
    }

    async fn start_with_optional_extensions(
        session_dir: &Path,
        working_dir: &Path,
        extension_paths: &[PathBuf],
        tool_names: Option<&str>,
        workflow_role: Option<&str>,
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
            match Self::start_with_program(
                program,
                &session_dir,
                &working_dir,
                extension_paths,
                tool_names,
                workflow_role,
            )
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
        Self::start_no_session_optional(working_dir, &[], None, None).await
    }

    pub async fn start_no_session_managed(
        working_dir: &Path,
        extension_paths: &[PathBuf],
        tool_names: &str,
        workflow_role: Option<&str>,
    ) -> Result<Self, AppError> {
        Self::start_no_session_optional(
            working_dir,
            extension_paths,
            Some(tool_names),
            workflow_role,
        )
        .await
    }

    async fn start_no_session_optional(
        working_dir: &Path,
        extension_paths: &[PathBuf],
        tool_names: Option<&str>,
        workflow_role: Option<&str>,
    ) -> Result<Self, AppError> {
        let working_dir = normalize_local_path(working_dir)?;
        let candidates: Vec<&str> = if cfg!(target_os = "windows") {
            vec!["pi.cmd", "pi.exe", "pi"]
        } else {
            vec!["pi"]
        };
        let mut last_error = None;
        for program in &candidates {
            match Self::start_with_program_no_session(
                program,
                &working_dir,
                extension_paths,
                tool_names,
                workflow_role,
            )
            .await
            {
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
        extension_paths: &[PathBuf],
        tool_names: Option<&str>,
        workflow_role: Option<&str>,
    ) -> Result<Self, AppError> {
        let git_executable = trusted_git_executable(working_dir)?;
        let transport_config = match tool_names {
            Some(tool_names) => PiRpcTransportConfig::no_session_with_tools(
                program,
                working_dir,
                extension_paths,
                tool_names,
            ),
            None => PiRpcTransportConfig::no_session(program, working_dir),
        };
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
            .args(transport_config.extra_args())
            .env("RACCOON_PI_EXECUTABLE", program)
            .env("RACCOON_GIT_EXECUTABLE", git_executable);
        if let Some(workflow_role) = workflow_role {
            command.env("RACCOON_WORKFLOW_ROLE", workflow_role);
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
        extension_paths: &[PathBuf],
        tool_names: Option<&str>,
        workflow_role: Option<&str>,
    ) -> Result<Self, AppError> {
        let git_executable = trusted_git_executable(working_dir)?;
        let transport_config = match tool_names {
            Some(tool_names) => PiRpcTransportConfig::session_with_tools(
                program,
                session_dir,
                working_dir,
                extension_paths,
                tool_names,
            ),
            None => {
                PiRpcTransportConfig::session(program, session_dir, working_dir, extension_paths)
            }
        };
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
        command
            .env("RACCOON_PI_EXECUTABLE", program)
            .env("RACCOON_GIT_EXECUTABLE", git_executable);
        if let Some(workflow_role) = workflow_role {
            command.env("RACCOON_WORKFLOW_ROLE", workflow_role);
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
        let usage_before = self.get_session_stats().await.ok();
        let session_file = self.get_session_file().await?;
        if let (Some(emitter), Some(session_file)) = (&events, &session_file) {
            emitter.emit_pi_event(serde_json::json!({
                "type": "raccoon_session_bound",
                "sessionFile": session_file,
            }));
        }
        self.ensure_clarification_extension().await?;
        self.ensure_task_runtime_extension().await?;
        self.prepare_high_model(&input.model_settings).await?;
        let rendered_prompt = build_requirement_prompt(&input, session_reused);
        self.prompt_with_images(&rendered_prompt.markdown, &input.prompt_images)
            .await?;
        let mut pi_events = Vec::new();
        let mut observation = OperationRuntimeObservation::new(
            Duration::from_secs(OPERATION_WARNING_SECONDS),
            Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
            None,
        );
        let wait_result = self
            .wait_for_agent_end_with_events(
                Duration::from_secs(OPERATION_WARNING_SECONDS),
                Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
                &events,
                None,
                &mut observation,
                |event| {
                    if let Some(emitter) = &events {
                        emitter.emit_pi_event(event.clone());
                    }
                    pi_events.push(event);
                },
            )
            .await;
        if let Err(error) = wait_result {
            return Err(AppError::task_execution_with_trace(
                error.to_string(),
                session_file,
                attach_runtime_observation(
                    build_failure_trace(&pi_events, session_reused),
                    &observation,
                ),
            ));
        }

        let mut output = parse_requirement_tool_analysis(&pi_events, session_file.clone(), None);
        if output.status == RequirementStatus::DraftReady {
            let validation = output
                .draft
                .as_ref()
                .ok_or_else(|| AppError::internal("DraftReady 缺少 ChangeSpec"))
                .and_then(|draft| validate_change_spec(draft, Some(&input.messages)));
            if let Err(error) = validation {
                if let Some(emitter) = &events {
                    emitter.emit(
                        "change_spec_repair_started",
                        "ChangeSpec 证据引用无效，正在同一会话内修正。",
                    );
                }
                let repair_start = pi_events.len();
                let repair_prompt = format!(
                    "你提交的 ChangeSpec 未通过证据校验：{error}\n\
                     只修正 explicit_constraints 的 source_message_id/source_quote；不要重新读取仓库、不要改变 intent、acceptance_scenarios、约束陈述或 non_goals。\n\
                     如果某项只是普通目标或行为事实而非用户明确指定的技术限制，请删除该 explicit_constraint。\n\
                     立即再次调用 submit_change_spec，不要调用其他工具。\n\n{}",
                    format_requirement_evidence_index(&input.messages)
                );
                self.prompt(&repair_prompt).await?;
                let repair_result = self
                    .wait_for_agent_end_with_events(
                        Duration::from_secs(OPERATION_WARNING_SECONDS),
                        Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
                        &events,
                        None,
                        &mut observation,
                        |event| {
                            if let Some(emitter) = &events {
                                emitter.emit_pi_event(event.clone());
                            }
                            pi_events.push(event);
                        },
                    )
                    .await;
                if let Err(error) = repair_result {
                    if let Some(emitter) = &events {
                        emitter.emit(
                            "change_spec_repair_failed",
                            "ChangeSpec 同会话修正发生技术失败。",
                        );
                    }
                    return Err(AppError::task_execution_with_trace(
                        error.to_string(),
                        session_file,
                        attach_runtime_observation(
                            build_failure_trace(&pi_events, true),
                            &observation,
                        ),
                    ));
                }
                let repaired = parse_requirement_tool_analysis(
                    &pi_events[repair_start..],
                    session_file.clone(),
                    None,
                );
                let repaired_validation = if repaired.status == RequirementStatus::DraftReady {
                    repaired
                        .draft
                        .as_ref()
                        .ok_or_else(|| AppError::internal("DraftReady 缺少 ChangeSpec"))
                        .and_then(|draft| validate_change_spec(draft, Some(&input.messages)))
                } else {
                    Err(AppError::bad_request(
                        repaired
                            .error
                            .clone()
                            .unwrap_or_else(|| "修正轮未提交 ChangeSpec".to_owned()),
                    ))
                };
                match repaired_validation {
                    Ok(()) => {
                        output = repaired;
                        if let Some(emitter) = &events {
                            emitter.emit(
                                "change_spec_repair_completed",
                                "ChangeSpec 证据引用已修正。",
                            );
                        }
                    }
                    Err(error) => {
                        output = RequirementAnalysisOutput {
                            status: RequirementStatus::Failed,
                            assistant_message: format!("ChangeSpec 修正后仍不合法：{error}"),
                            progress: String::new(),
                            clarifications: Vec::new(),
                            draft: None,
                            pi_session_file: session_file.clone(),
                            error: Some(error.to_string()),
                            failure_stage: Some(RequirementFailureStage::ChangeSpecValidation),
                            failure_code: Some("constraint_evidence_invalid".to_owned()),
                            trace: None,
                        };
                        if let Some(emitter) = &events {
                            emitter.emit(
                                "change_spec_repair_failed",
                                "ChangeSpec 修正后仍未通过证据校验。",
                            );
                        }
                    }
                }
            }
        }

        let trace = self
            .attach_session_usage(
                attach_prompt_diagnostics(
                    attach_compaction_observability(
                        crate::requirement::build_pi_trace_metadata(&pi_events),
                        &pi_events,
                    ),
                    &rendered_prompt.diagnostics,
                ),
                session_reused,
                usage_before.as_ref(),
            )
            .await;
        let trace = attach_runtime_observation(trace, &observation);
        output.pi_session_file = session_file;
        output.trace = trace;
        Ok(output)
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
                    command.get("name").and_then(Value::as_str) == Some("raccoon-requirements")
                })
            });
        if !available {
            return Err(AppError::internal("受管 Pi 需求澄清插件未加载或协议不兼容"));
        }
        Ok(())
    }

    async fn ensure_parallel_review_extension(&self) -> Result<(), AppError> {
        let response = self
            .send_command(serde_json::json!({ "type": "get_commands" }))
            .await?;
        let available = response
            .pointer("/data/commands")
            .and_then(Value::as_array)
            .is_some_and(|commands| {
                commands.iter().any(|command| {
                    command.get("name").and_then(Value::as_str) == Some("raccoon-parallel-review")
                })
            });
        if available {
            Ok(())
        } else {
            Err(AppError::internal(
                "受管 Pi 内存子 Agent 审核插件未加载或协议不兼容",
            ))
        }
    }

    async fn ensure_task_runtime_extension(&self) -> Result<(), AppError> {
        let response = self
            .send_command(serde_json::json!({ "type": "get_commands" }))
            .await?;
        let available = response
            .pointer("/data/commands")
            .and_then(Value::as_array)
            .is_some_and(|commands| {
                commands.iter().any(|command| {
                    command.get("name").and_then(Value::as_str) == Some("raccoon-task-runtime")
                })
            });
        if available {
            Ok(())
        } else {
            Err(AppError::internal(
                "受管 Pi 任务运行时插件未加载或协议不兼容",
            ))
        }
    }

    pub async fn plan_workflow(
        &self,
        input: WorkflowPlanInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<WorkflowPlanOutput, AppError> {
        self.new_session().await?;
        self.ensure_task_runtime_extension().await?;
        let usage_before = self.get_session_stats().await.ok();
        self.prepare_high_model(&input.model_settings).await?;
        let rendered_prompt = build_workflow_plan_prompt(&input);
        let change_spec = change_spec_from_requirement(&input.requirement)?;
        let parse = |events: &[Value]| -> Result<crate::workflow::WorkPlan, AppError> {
            let payload = parse_workflow_payload(events, "submit_work_plan", "work_plan")?;
            let plan = serde_json::from_value::<crate::workflow::WorkPlan>(payload)?;
            compile_work_plan(
                &input.requirement.id,
                input.requirement.analysis_revision,
                change_spec.clone(),
                plan.clone(),
            )?;
            Ok(plan)
        };
        let mut response = self
            .prompt_and_extract_response(
                &rendered_prompt.markdown,
                Duration::from_secs(OPERATION_WARNING_SECONDS),
                Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
                &events,
                None,
                false,
            )
            .await?;
        response.trace = attach_prompt_diagnostics(response.trace, &rendered_prompt.diagnostics);
        let plan = match parse(&response.events) {
            Ok(plan) => plan,
            Err(error) => {
                let repair = format!(
                    "上一份 WorkPlan 未通过结构或业务校验：{error}\n不要重新调研仓库。只修正结构、依赖、契约或证据，并立即再次调用 submit_work_plan。"
                );
                response = self
                    .prompt_and_extract_response(
                        &repair,
                        Duration::from_secs(OPERATION_WARNING_SECONDS),
                        Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
                        &events,
                        None,
                        true,
                    )
                    .await?;
                response.trace =
                    attach_prompt_diagnostics(response.trace, &rendered_prompt.diagnostics);
                parse(&response.events).map_err(|repair_error| {
                    AppError::task_execution_with_trace(
                        format!("WorkPlan 修正后仍不合法：{repair_error}"),
                        None,
                        response.trace.clone(),
                    )
                })?
            }
        };
        let trace = self
            .attach_session_usage(response.trace, false, usage_before.as_ref())
            .await;
        Ok(WorkflowPlanOutput { plan, trace })
    }

    pub async fn execute_workflow_attempt(
        &self,
        input: WorkflowAgentInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<WorkflowAgentOutput, AppError> {
        let restored = self
            .restore_or_new_session(input.resume_session_file.as_deref())
            .await?;
        if input.resume_session_file.is_some() && !restored {
            return Err(AppError::internal(
                "Rescue 反馈必须恢复原 Pi 会话，但原会话不可用",
            ));
        }
        self.ensure_task_runtime_extension().await?;
        let usage_before = self.get_session_stats().await.ok();
        if input.attempt_kind == WorkflowAttemptKind::Rescue {
            self.prepare_high_model(&input.model_settings).await?;
        } else {
            self.prepare_model_tier(&input.model_settings, input.model_tier)
                .await?;
        }
        let git_guard = TaskGitState::capture(&self.working_dir).await?;
        let rendered_prompt = build_workflow_attempt_prompt(&input);
        let mut response = self
            .prompt_and_extract_response(
                &rendered_prompt.markdown,
                Duration::from_secs(OPERATION_WARNING_SECONDS),
                Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
                &events,
                Some(
                    if input.attempt_kind == WorkflowAttemptKind::Implementation {
                        500_000
                    } else {
                        250_000
                    },
                ),
                false,
            )
            .await?;
        let expected_kind = if input.attempt_kind == WorkflowAttemptKind::Rescue {
            "rescue"
        } else {
            "work_item"
        };
        let parse = |events: &[Value]| -> Result<WorkflowAgentPayload, AppError> {
            let payload = parse_workflow_payload(events, "submit_workflow_result", expected_kind)?;
            let payload = serde_json::from_value::<WorkflowAgentPayload>(payload)?;
            if !payload.changed
                && payload
                    .no_op_reason
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
            {
                return Err(AppError::internal("changed=false 时必须说明 no_op_reason"));
            }
            Ok(payload)
        };
        let payload = match parse(&response.events) {
            Ok(payload) => payload,
            Err(error) => {
                response = self
                    .prompt_and_extract_response(
                        &format!(
                            "你的实现结果没有按协议提交：{error}\n不要重新读取或修改代码，只调用 submit_workflow_result 提交当前结果。"
                        ),
                        Duration::from_secs(OPERATION_WARNING_SECONDS),
                        Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
                        &events,
                        None,
                        true,
                    )
                    .await?;
                parse(&response.events).map_err(|repair_error| {
                    AppError::task_execution_with_trace(
                        format!("工作项结构化结果修正后仍不合法：{repair_error}"),
                        None,
                        response.trace.clone(),
                    )
                })?
            }
        };
        response.trace = attach_prompt_diagnostics(response.trace, &rendered_prompt.diagnostics);
        response.trace = self
            .attach_session_usage(response.trace, false, usage_before.as_ref())
            .await;
        git_guard.verify(&self.working_dir).await.map_err(|error| {
            AppError::task_execution_with_trace(error.to_string(), None, response.trace.clone())
        })?;
        let diff = git(
            &self.working_dir,
            &["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"],
        )
        .await?;
        let summary = if payload.changed {
            payload.result_summary
        } else {
            format!(
                "{}（未修改：{}）",
                payload.result_summary,
                payload.no_op_reason.unwrap_or_default()
            )
        };
        Ok(WorkflowAgentOutput {
            completed: payload.outcome == "completed",
            changed: payload.changed,
            result_summary: summary,
            pi_session_file: self.get_session_file().await?,
            worktree_fingerprint: Some(format!("diff:{:016x}", text_fingerprint(&diff))),
            usage: response.trace,
        })
    }

    pub async fn review_workflow_checkpoint(
        &self,
        input: WorkflowReviewInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<WorkflowReviewOutput, AppError> {
        self.new_session().await?;
        self.ensure_parallel_review_extension().await?;
        let usage_before = self.get_session_stats().await.ok();
        if matches!(
            input.checkpoint.kind,
            crate::workflow::CheckpointKind::Final | crate::workflow::CheckpointKind::Rescue
        ) {
            self.prepare_high_model(&input.model_settings).await?;
        } else {
            self.prepare_model_tier(&input.model_settings, RequirementModelTier::Medium)
                .await?;
        }
        let rendered_prompt = build_workflow_review_prompt(&input);
        self.prompt(&rendered_prompt.markdown).await?;
        let mut pi_events = Vec::new();
        let mut observation = OperationRuntimeObservation::new(
            Duration::from_secs(OPERATION_WARNING_SECONDS),
            Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
            None,
        );
        self.wait_for_agent_end_with_events(
            Duration::from_secs(OPERATION_WARNING_SECONDS),
            Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
            &events,
            None,
            &mut observation,
            |event| {
                if let Some(emitter) = &events {
                    emitter.emit_pi_event(event.clone());
                }
                pi_events.push(event);
            },
        )
        .await?;
        let details = parallel_review_tool_details(&pi_events)
            .ok_or_else(|| AppError::internal("并行审核未返回结构化 details"))?;
        let protocol = details.get("protocol").and_then(Value::as_str);
        if protocol != Some("raccoon:parallel-review") {
            return Err(AppError::internal("并行审核协议不匹配"));
        }
        let mut findings = Vec::new();
        let mut technical_failures = Vec::new();
        let expected_angles = input
            .checkpoint
            .required_angles
            .iter()
            .copied()
            .collect::<HashSet<_>>();
        let selected_angles = details
            .pointer("/selection/angles")
            .and_then(Value::as_array)
            .map(|angles| {
                angles
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(parse_review_angle)
                    .collect::<HashSet<_>>()
            });
        if selected_angles.as_ref() != Some(&expected_angles) {
            technical_failures.push("审核 selection 与 checkpoint 所需角度不一致".to_owned());
        }
        let reviews = details.get("reviews").and_then(Value::as_array);
        if reviews.is_none() {
            technical_failures.push("并行审核 details 缺少 reviews".to_owned());
        }
        let mut seen_angles = HashSet::new();
        let scenario_refs = input
            .run
            .change_spec
            .acceptance_scenarios
            .iter()
            .map(|scenario| scenario.id.as_str())
            .collect::<HashSet<_>>();
        for review in reviews.into_iter().flatten() {
            let angle_text = review.get("angle").and_then(Value::as_str).unwrap_or("");
            let Some(angle) = parse_review_angle(angle_text) else {
                technical_failures.push(format!("未知审核角度：{angle_text}"));
                continue;
            };
            if !expected_angles.contains(&angle) {
                technical_failures.push(format!("返回了未选择的审核角度：{angle_text}"));
                continue;
            }
            if !seen_angles.insert(angle) {
                technical_failures.push(format!("重复返回审核角度：{angle_text}"));
                continue;
            }
            if review.get("transport_status").and_then(Value::as_str) != Some("completed") {
                technical_failures.push(format!(
                    "{angle_text}：{}",
                    review
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("技术失败")
                ));
                continue;
            }
            let result = review.get("result").unwrap_or(&Value::Null);
            let Some(raw_findings) = result.get("findings").and_then(Value::as_array) else {
                technical_failures.push(format!("{angle_text}：结构化结果缺少 findings"));
                continue;
            };
            if raw_findings.len() > 5 {
                technical_failures.push(format!("{angle_text}：finding 超过 5 个"));
                continue;
            }
            for raw in raw_findings {
                if let Some(reference) = raw.get("scenario_ref").and_then(Value::as_str)
                    && (angle != crate::workflow::ReviewAngle::Correctness
                        || !scenario_refs.contains(reference))
                {
                    technical_failures.push(format!("{angle_text}：非法 scenario_ref {reference}"));
                    continue;
                }
                findings.push(parse_workflow_finding(&input.checkpoint.id, angle, raw)?);
            }
        }
        if seen_angles != expected_angles {
            technical_failures.push("审核结果缺少一个或多个选中角度".to_owned());
        }
        let trace = attach_runtime_observation(
            attach_prompt_diagnostics(
                crate::requirement::build_pi_trace_metadata(&pi_events),
                &rendered_prompt.diagnostics,
            ),
            &observation,
        );
        let usage = self
            .attach_session_usage(trace, false, usage_before.as_ref())
            .await;
        let report =
            crate::workflow::ReviewReport::from_details(details).map_err(AppError::internal)?;
        Ok(WorkflowReviewOutput {
            findings,
            technical_failure: (!technical_failures.is_empty())
                .then(|| technical_failures.join("；")),
            usage,
            details: Some(report),
        })
    }

    pub async fn ask_project_chat(
        &self,
        input: ProjectChatInput,
        events: Option<ProjectChatEventEmitter>,
    ) -> Result<ProjectChatOutput, AppError> {
        let session_reused = self
            .restore_or_new_session(input.pi_session_file.as_deref())
            .await?;
        let usage_before = self.get_session_stats().await.ok();
        self.ensure_task_runtime_extension().await?;
        self.prepare_model_tier(&input.model_settings, RequirementModelTier::Medium)
            .await?;
        let rendered_prompt = crate::chat::build_project_chat_prompt(&input, session_reused);
        self.prompt_with_images(&rendered_prompt.markdown, &input.prompt_images)
            .await?;
        let mut pi_events = Vec::new();
        let no_requirement_events = None;
        let mut observation = OperationRuntimeObservation::new(
            Duration::from_secs(OPERATION_WARNING_SECONDS),
            Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
            None,
        );
        let wait_result = self
            .wait_for_agent_end_with_events(
                Duration::from_secs(OPERATION_WARNING_SECONDS),
                Duration::from_secs(OPERATION_IDLE_TIMEOUT_SECONDS),
                &no_requirement_events,
                None,
                &mut observation,
                |event| {
                    if let Some(emitter) = &events {
                        emitter.emit_pi_event(event.clone());
                    }
                    pi_events.push(event);
                },
            )
            .await;
        if let Err(error) = wait_result {
            return Err(AppError::task_execution_with_trace(
                error.to_string(),
                self.get_session_file().await.ok().flatten(),
                attach_runtime_observation(
                    build_failure_trace(&pi_events, session_reused),
                    &observation,
                ),
            ));
        }
        let mut response = match self.extract_pi_response(&pi_events).await {
            Ok(response) => response,
            Err(failure) => {
                log_pi_response_failure(&failure);
                return Err(AppError::task_execution_with_trace(
                    failure.message,
                    self.get_session_file().await.ok().flatten(),
                    attach_runtime_observation(
                        build_failure_trace(&pi_events, session_reused).or(failure.trace),
                        &observation,
                    ),
                ));
            }
        };
        response.trace = attach_prompt_diagnostics(response.trace, &rendered_prompt.diagnostics);
        response.trace = self
            .attach_session_usage(response.trace, session_reused, usage_before.as_ref())
            .await;
        response.trace = attach_runtime_observation(response.trace, &observation);
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
        before: Option<&Value>,
    ) -> Option<Value> {
        let stats = match self.get_session_stats().await {
            Ok(stats) => stats,
            Err(error) => {
                tracing::warn!("读取 Pi Agent 会话统计失败：{error}");
                return trace;
            }
        };
        let trace = attach_session_usage(trace, &stats, session_reused, before);
        let auto_enabled = match self
            .send_command(serde_json::json!({ "type": "get_state" }))
            .await
        {
            Ok(state) => state
                .pointer("/data/autoCompactionEnabled")
                .and_then(Value::as_bool),
            Err(error) => {
                tracing::warn!("读取 Pi Agent 自动压缩状态失败：{error}");
                None
            }
        };
        attach_auto_compaction_state(trace, auto_enabled)
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
                    trace: attach_compaction_observability(
                        crate::requirement::build_pi_trace_metadata(events),
                        events,
                    ),
                })?;
        extract_pi_response(events, last_assistant_text)
            .map(|mut response| {
                response.trace = attach_compaction_observability(response.trace, events);
                response
            })
            .map_err(|mut failure| {
                failure.trace = attach_compaction_observability(failure.trace, events);
                failure
            })
    }

    async fn prompt_and_extract_response(
        &self,
        prompt: &str,
        warning_after: Duration,
        idle_timeout: Duration,
        events: &Option<RequirementEventEmitter>,
        input_budget: Option<u64>,
        session_reused: bool,
    ) -> Result<crate::requirement::PiResponseExtraction, AppError> {
        self.prompt(prompt).await?;
        let mut pi_events = Vec::new();
        let mut observation =
            OperationRuntimeObservation::new(warning_after, idle_timeout, input_budget);
        let wait_result = self
            .wait_for_agent_end_with_events(
                warning_after,
                idle_timeout,
                events,
                input_budget,
                &mut observation,
                |event| {
                    if let Some(emitter) = events {
                        emitter.emit_pi_event(event.clone());
                    }
                    pi_events.push(event);
                },
            )
            .await;
        if let Err(error) = wait_result {
            return Err(AppError::task_execution_with_trace(
                error.to_string(),
                self.get_session_file().await.ok().flatten(),
                attach_runtime_observation(
                    build_failure_trace(&pi_events, session_reused),
                    &observation,
                ),
            ));
        }
        let mut response = match self.extract_pi_response(&pi_events).await {
            Ok(response) => response,
            Err(failure) => {
                log_pi_response_failure(&failure);
                return Err(AppError::task_execution_with_trace(
                    failure.message,
                    self.get_session_file().await.ok().flatten(),
                    attach_runtime_observation(
                        build_failure_trace(&pi_events, session_reused).or(failure.trace),
                        &observation,
                    ),
                ));
            }
        };
        response.trace = self
            .attach_session_usage(response.trace, session_reused, None)
            .await;
        response.trace = attach_runtime_observation(response.trace, &observation);
        Ok(response)
    }

    async fn wait_for_agent_end_with_events<F>(
        &self,
        warning_after: Duration,
        idle_timeout: Duration,
        events: &Option<RequirementEventEmitter>,
        input_budget: Option<u64>,
        observation: &mut OperationRuntimeObservation,
        mut on_event: F,
    ) -> Result<(), AppError>
    where
        F: FnMut(Value) + Send,
    {
        let mut io = self.io.lock().await;
        let mut line = String::new();
        let mut last_output_at = Instant::now();
        let mut warned = false;
        let mut operation_input = 0_u64;
        let mut terminal_pending = false;
        let cancelled = io.cancelled.clone();

        *observation = OperationRuntimeObservation::new(warning_after, idle_timeout, input_budget);

        loop {
            if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = io.child.start_kill();
                observation.termination_reason = "cancelled";
                return Err(AppError::internal("分析已被用户取消"));
            }

            let idle_for = last_output_at.elapsed();
            observation.max_idle = observation.max_idle.max(idle_for);
            if !warned && idle_for > warning_after {
                warned = true;
                observation.idle_warning_count += 1;
                if let Some(emitter) = &events {
                    emitter.emit(
                        "coordinator_time_warning",
                        "Pi Agent 已较长时间没有产生新活动，可取消或继续等待",
                    );
                }
            }

            line.clear();
            let remaining = idle_timeout.saturating_sub(idle_for);
            let wait_for = if terminal_pending {
                remaining.min(Duration::from_millis(250))
            } else {
                remaining
            };
            tokio::select! {
                read = io.stdout.read_line(&mut line) => {
                    let read = match read {
                        Ok(read) => read,
                        Err(error) => {
                            observation.termination_reason = "rpc_read_error";
                            return Err(error.into());
                        }
                    };
                    if read == 0 {
                        let _ = io.child.start_kill();
                        observation.termination_reason = "process_exit";
                        return Err(AppError::internal("Pi Agent RPC 已退出"));
                    }
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let value: Value = match serde_json::from_str(trimmed) {
                        Ok(value) => value,
                        Err(error) => {
                            observation.termination_reason = "invalid_rpc_event";
                            return Err(error.into());
                        }
                    };
                    if value.get("type") == Some(&serde_json::json!("response")) {
                        continue;
                    }

                    let has_activity = event_has_output_activity(&value);
                    let terminal = is_terminal_agent_end(&value);
                    terminal_pending = next_terminal_pending(terminal_pending, &value, terminal);
                    operation_input = operation_input.saturating_add(assistant_message_input(&value));
                    observation.observed_input = operation_input;
                    on_event(value);
                    if let Some(budget) = input_budget
                        && operation_input > budget
                        && !observation.budget_warning_emitted
                    {
                        observation.budget_warning_emitted = true;
                        if let Some(emitter) = &events {
                            emitter.emit(
                                "coordinator_token_budget_warning",
                                &format!(
                                    "Pi Agent operation input 已超观测预算：{operation_input} > {budget}；任务将继续运行"
                                ),
                            );
                        }
                    }
                    if has_activity {
                        last_output_at = Instant::now();
                        warned = false;
                        observation.activity_count += 1;
                    }
                }
                _ = tokio::time::sleep(wait_for) => {
                    if terminal_pending {
                        observation.termination_reason = "completed";
                        break;
                    }
                    let _ = io.child.start_kill();
                    observation.termination_reason = "idle_timeout";
                    return Err(AppError::internal("等待 Pi Agent 新输出空闲超时"));
                }
                _ = self.cancel_notify.notified() => {
                    let _ = io.child.start_kill();
                    observation.termination_reason = "cancelled";
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

fn is_terminal_agent_end(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("agent_end")
        && event.get("willRetry").and_then(Value::as_bool) != Some(true)
}

fn next_terminal_pending(current: bool, event: &Value, terminal_agent_end: bool) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("agent_start" | "compaction_start") => false,
        Some("compaction_end") => event.get("willRetry").and_then(Value::as_bool) != Some(true),
        _ if terminal_agent_end => true,
        _ => current,
    }
}

#[derive(Debug)]
struct TaskGitState {
    head: String,
    branch: String,
    branch_ref: String,
    staged_fingerprint: u64,
}

impl TaskGitState {
    async fn capture(worktree: &Path) -> Result<Self, AppError> {
        let head = git(worktree, &["rev-parse", "HEAD"]).await?;
        let branch = git(worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
        let branch_ref = git(worktree, &["symbolic-ref", "-q", "HEAD"])
            .await
            .unwrap_or_default();
        let staged = git(
            worktree,
            &[
                "diff",
                "--cached",
                "--binary",
                "--no-ext-diff",
                "--no-textconv",
            ],
        )
        .await?;
        Ok(Self {
            head: head.trim().to_owned(),
            branch: branch.trim().to_owned(),
            branch_ref: branch_ref.trim().to_owned(),
            staged_fingerprint: text_fingerprint(&staged),
        })
    }

    async fn verify(&self, worktree: &Path) -> Result<(), AppError> {
        let current = Self::capture(worktree).await?;
        if self.head != current.head {
            return Err(AppError::internal(
                "任务 Agent 修改了 HEAD；Git 写操作必须由外部调度器执行",
            ));
        }
        if self.branch != current.branch || self.branch_ref != current.branch_ref {
            return Err(AppError::internal(
                "任务 Agent 修改了当前分支；Git 写操作必须由外部调度器执行",
            ));
        }
        if self.staged_fingerprint != current.staged_fingerprint {
            return Err(AppError::internal(
                "任务 Agent 修改了暂存区；Git 写操作必须由外部调度器执行",
            ));
        }
        Ok(())
    }
}

fn text_fingerprint(value: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
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
        Some("tool_execution_start") | Some("tool_execution_end") => true,
        Some("tool_execution_update") => ["partialResult", "partial_result", "result", "output"]
            .iter()
            .any(|key| event.get(*key).is_some_and(value_has_non_empty_text)),
        Some("agent_start")
        | Some("turn_start")
        | Some("turn_end")
        | Some("auto_retry_start")
        | Some("auto_retry_end")
        | Some("compaction_start")
        | Some("compaction_end") => true,
        _ => false,
    }
}

fn assistant_message_input(event: &Value) -> u64 {
    if event.get("type").and_then(Value::as_str) != Some("message_end")
        || event.pointer("/message/role").and_then(Value::as_str) != Some("assistant")
    {
        return 0;
    }
    event
        .pointer("/message/usage/input")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn build_failure_trace(events: &[Value], session_reused: bool) -> Option<Value> {
    let mut trace = attach_compaction_observability(
        crate::requirement::build_pi_trace_metadata(events),
        events,
    )?;
    let mut call_count = 0_u64;
    let mut input = 0_u64;
    let mut output = 0_u64;
    let mut cache_read = 0_u64;
    let mut cache_write = 0_u64;
    for event in events {
        if event.get("type").and_then(Value::as_str) != Some("message_end")
            || event.pointer("/message/role").and_then(Value::as_str) != Some("assistant")
        {
            continue;
        }
        let usage = event.pointer("/message/usage").unwrap_or(&Value::Null);
        call_count += 1;
        input = input.saturating_add(usage.get("input").and_then(Value::as_u64).unwrap_or(0));
        output = output.saturating_add(usage.get("output").and_then(Value::as_u64).unwrap_or(0));
        cache_read =
            cache_read.saturating_add(usage.get("cacheRead").and_then(Value::as_u64).unwrap_or(0));
        cache_write = cache_write
            .saturating_add(usage.get("cacheWrite").and_then(Value::as_u64).unwrap_or(0));
    }
    trace["trace"]["usage"] = serde_json::json!({
        "scope": "operation",
        "sessionReused": session_reused,
        "callCount": call_count,
        "input": input,
        "output": output,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
    });
    trace["trace"]["operationId"] = serde_json::json!(next_operation_id());
    Some(trace)
}

fn attach_runtime_observation(
    mut trace: Option<Value>,
    observation: &OperationRuntimeObservation,
) -> Option<Value> {
    let trace_data = trace.as_mut()?.get_mut("trace")?.as_object_mut()?;
    trace_data.insert(
        "runtime".to_owned(),
        serde_json::json!({
            "warningAfterSeconds": observation.warning_after.as_secs(),
            "idleTimeoutSeconds": observation.idle_timeout.as_secs(),
            "maxIdleMilliseconds": observation.max_idle.as_millis().min(u128::from(u64::MAX)) as u64,
            "activityCount": observation.activity_count,
            "idleWarningCount": observation.idle_warning_count,
            "terminationReason": observation.termination_reason,
            "absoluteTimeout": false,
        }),
    );
    if let Some(limit) = observation.input_budget {
        let observed = observation.observed_input;
        trace_data.insert(
            "budget".to_owned(),
            serde_json::json!({
                "limit": limit,
                "observed": observed,
                "ratio": if limit == 0 { 0.0 } else { observed as f64 / limit as f64 },
                "exceeded": observed > limit,
                "enforced": false,
                "warningEmitted": observation.budget_warning_emitted,
            }),
        );
    }
    trace
}

fn next_operation_id() -> String {
    format!(
        "operation-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        PI_OPERATION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
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

fn attach_compaction_observability(mut trace: Option<Value>, events: &[Value]) -> Option<Value> {
    let trace_data = trace.as_mut()?.get_mut("trace")?.as_object_mut()?;
    let mut attempts: Vec<Value> = Vec::new();

    for event in events {
        let event_type = event.get("type").and_then(Value::as_str);
        let reason = event
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        match event_type {
            Some("compaction_start") => attempts.push(serde_json::json!({
                "reason": reason,
                "status": "running",
                "willRetry": false,
                "usageKnown": false,
            })),
            Some("compaction_end") => {
                let result = event.get("result").unwrap_or(&Value::Null);
                let aborted = event
                    .get("aborted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let error = event
                    .get("errorMessage")
                    .or_else(|| event.get("error"))
                    .and_then(Value::as_str);
                let status = if aborted {
                    "aborted"
                } else if error.is_some() || result.is_null() {
                    "failed"
                } else {
                    "completed"
                };
                let tokens_before = result.get("tokensBefore").and_then(Value::as_u64);
                let estimated_after = result.get("estimatedTokensAfter").and_then(Value::as_u64);
                let estimated_saved = tokens_before
                    .zip(estimated_after)
                    .map(|(before, after)| before.saturating_sub(after));
                let mut normalized = serde_json::json!({
                    "reason": reason,
                    "status": status,
                    "willRetry": event
                        .get("willRetry")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    "usageKnown": false,
                });
                if let Some(value) = tokens_before {
                    normalized["tokensBefore"] = serde_json::json!(value);
                }
                if let Some(value) = estimated_after {
                    normalized["estimatedTokensAfter"] = serde_json::json!(value);
                }
                if let Some(value) = estimated_saved {
                    normalized["estimatedTokensSaved"] = serde_json::json!(value);
                }
                if let Some(value) = error {
                    normalized["error"] = serde_json::json!(value);
                }

                if let Some(started) = attempts.iter_mut().rev().find(|attempt| {
                    attempt.get("status").and_then(Value::as_str) == Some("running")
                        && attempt.get("reason").and_then(Value::as_str) == Some(reason)
                }) {
                    *started = normalized;
                } else {
                    attempts.push(normalized);
                }
            }
            _ => {}
        }
    }

    if attempts.is_empty() {
        return trace;
    }

    let completed = attempts
        .iter()
        .filter(|attempt| attempt.get("status").and_then(Value::as_str) == Some("completed"))
        .count() as u64;
    let aborted = attempts
        .iter()
        .filter(|attempt| attempt.get("status").and_then(Value::as_str) == Some("aborted"))
        .count() as u64;
    let failed = attempts
        .iter()
        .filter(|attempt| attempt.get("status").and_then(Value::as_str) == Some("failed"))
        .count() as u64;
    let overflow_retries = attempts
        .iter()
        .filter(|attempt| {
            attempt.get("reason").and_then(Value::as_str) == Some("overflow")
                && attempt.get("willRetry").and_then(Value::as_bool) == Some(true)
        })
        .count() as u64;
    let estimated_tokens_saved = attempts
        .iter()
        .filter_map(|attempt| attempt.get("estimatedTokensSaved").and_then(Value::as_u64))
        .sum::<u64>();

    trace_data.insert(
        "compaction".to_owned(),
        serde_json::json!({
            "usageKnown": false,
            "estimated": true,
            "count": attempts.len(),
            "completed": completed,
            "aborted": aborted,
            "failed": failed,
            "overflowRetries": overflow_retries,
            "estimatedTokensSaved": estimated_tokens_saved,
            "events": attempts,
        }),
    );
    trace
}

fn attach_auto_compaction_state(
    mut trace: Option<Value>,
    auto_enabled: Option<bool>,
) -> Option<Value> {
    let trace_data = trace.as_mut()?.get_mut("trace")?.as_object_mut()?;
    let compaction = trace_data
        .entry("compaction".to_owned())
        .or_insert_with(|| {
            serde_json::json!({
                "usageKnown": false,
                "estimated": true,
                "count": 0,
                "completed": 0,
                "aborted": 0,
                "failed": 0,
                "overflowRetries": 0,
                "estimatedTokensSaved": 0,
                "events": [],
            })
        });
    if let (Some(compaction), Some(enabled)) = (compaction.as_object_mut(), auto_enabled) {
        compaction.insert("autoEnabled".to_owned(), Value::Bool(enabled));
    }
    trace
}

fn attach_session_usage(
    mut trace: Option<Value>,
    stats: &Value,
    session_reused: bool,
    before: Option<&Value>,
) -> Option<Value> {
    let trace_data = trace.as_mut()?.get_mut("trace")?.as_object_mut()?;
    let tokens = stats.get("tokens").unwrap_or(&Value::Null);
    let context = stats.get("contextUsage").unwrap_or(&Value::Null);
    let delta = |key: &str| {
        tokens
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_sub(
                before
                    .and_then(|value| value.pointer(&format!("/tokens/{key}")))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
    };
    let mut input = delta("input");
    let mut output = delta("output");
    let mut cache_read = delta("cacheRead");
    let mut cache_write = delta("cacheWrite");
    let call_count = stats
        .get("assistantMessages")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_sub(
            before
                .and_then(|value| value.get("assistantMessages"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );
    let mut subagents = serde_json::json!({
        "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
        "maxContextTokens": 0, "maxContextPercent": 0.0
    });
    if let Some(items) = trace_data.get("parallelReview").and_then(Value::as_array) {
        for item in items {
            let usage = item.get("usage").unwrap_or(&Value::Null);
            for (key, total) in [
                ("input", &mut input),
                ("output", &mut output),
                ("cacheRead", &mut cache_read),
                ("cacheWrite", &mut cache_write),
            ] {
                let value = usage.get(key).and_then(Value::as_u64).unwrap_or(0);
                *total += value;
                subagents[key] = serde_json::json!(subagents[key].as_u64().unwrap_or(0) + value);
            }
            let context_tokens = usage
                .pointer("/context/tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let context_percent = usage
                .pointer("/context/percent")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            subagents["maxContextTokens"] = serde_json::json!(
                subagents["maxContextTokens"]
                    .as_u64()
                    .unwrap_or(0)
                    .max(context_tokens)
            );
            subagents["maxContextPercent"] = serde_json::json!(
                subagents["maxContextPercent"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .max(context_percent)
            );
        }
    }
    trace_data.insert(
        "usage".to_owned(),
        serde_json::json!({
            "sessionReused": session_reused,
            "scope": if before.is_some() { "operation" } else { "session" },
            "callCount": call_count,
            "input": input,
            "output": output,
            "cacheRead": cache_read,
            "cacheWrite": cache_write,
            "subagents": subagents,
            "context": {
                "tokens": context.get("tokens").and_then(Value::as_u64).unwrap_or(0),
                "window": context.get("contextWindow").and_then(Value::as_u64).unwrap_or(0),
                "percent": context.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
            },
        }),
    );
    trace_data
        .entry("operationId".to_owned())
        .or_insert_with(|| serde_json::json!(next_operation_id()));
    trace
}

fn parse_workflow_payload(
    events: &[Value],
    tool_name: &str,
    expected_kind: &str,
) -> Result<Value, AppError> {
    let results = events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("tool_execution_end")
                && event.get("toolName").and_then(Value::as_str) == Some(tool_name)
                && event.get("isError").and_then(Value::as_bool) != Some(true)
        })
        .collect::<Vec<_>>();
    if results.len() != 1 {
        return Err(AppError::internal(format!(
            "受管工作流必须提交一次 {tool_name} 结果，实际为 {} 次",
            results.len()
        )));
    }
    let details = results[0]
        .pointer("/result/details")
        .ok_or_else(|| AppError::internal("受管工作流工具结果缺少 details"))?;
    if details.get("protocol").and_then(Value::as_str) != Some("raccoon:workflow-output") {
        return Err(AppError::internal("受管工作流输出协议不匹配"));
    }
    if details.get("kind").and_then(Value::as_str) != Some(expected_kind) {
        return Err(AppError::internal(format!(
            "受管工作流结果类型不匹配，预期 {expected_kind}"
        )));
    }
    details
        .get("payload")
        .cloned()
        .ok_or_else(|| AppError::internal("受管工作流工具结果缺少 payload"))
}

#[derive(Debug, Deserialize)]
struct WorkflowAgentPayload {
    outcome: String,
    changed: bool,
    no_op_reason: Option<String>,
    result_summary: String,
}

fn parallel_review_tool_details(events: &[Value]) -> Option<&Value> {
    events
        .iter()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("tool_execution_end")
                && event.get("toolName").and_then(Value::as_str) == Some("run_parallel_code_review")
        })
        .and_then(|event| event.pointer("/result/details"))
}

fn parse_workflow_finding(
    checkpoint_id: &str,
    angle: crate::workflow::ReviewAngle,
    raw: &Value,
) -> Result<WorkflowReviewFinding, AppError> {
    let required = |name: &str| {
        raw.get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::internal(format!("审核 finding 缺少 {name}")))
    };
    let category = required("category")?;
    let priority = match required("priority")? {
        "P0" => FindingPriority::P0,
        "P1" => FindingPriority::P1,
        "P2" => FindingPriority::P2,
        "P3" => FindingPriority::P3,
        value => {
            return Err(AppError::internal(format!(
                "审核 finding priority 非法：{value}"
            )));
        }
    };
    let summary = required("summary")?;
    let evidence = required("evidence")?;
    let path = required("path")?;
    let location = required("location")?;
    let angle_label = crate::workflow::review_angle_label(angle);
    let now = chrono::Utc::now();
    Ok(WorkflowReviewFinding {
        id: stable_workflow_finding_id(checkpoint_id, angle_label, category, path, location),
        checkpoint_id: checkpoint_id.to_owned(),
        angle,
        priority,
        status: FindingStatus::Open,
        category: category.to_owned(),
        path: Some(path.to_owned()),
        location: Some(location.to_owned()),
        summary: summary.to_owned(),
        evidence: evidence.to_owned(),
        reproduction: raw
            .get("reproduction")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        remediation: raw
            .get("remediation")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        scenario_ref: raw
            .get("scenario_ref")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        created_at: now,
        updated_at: now,
    })
}

fn stable_workflow_finding_id(
    checkpoint_id: &str,
    angle: &str,
    category: &str,
    path: &str,
    location: &str,
) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in [checkpoint_id, angle, category, path, location]
        .join("\0")
        .bytes()
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("finding-{hash:016x}")
}

fn log_pi_response_failure(failure: &PiResponseFailure) {
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
}

fn trusted_git_executable(working_dir: &Path) -> Result<PathBuf, AppError> {
    let path = std::env::var_os("PATH").ok_or_else(|| AppError::internal("PATH 未配置"))?;
    #[cfg(windows)]
    const GIT_NAMES: &[&str] = &["git.exe"];
    #[cfg(not(windows))]
    const GIT_NAMES: &[&str] = &["git"];

    for directory in std::env::split_paths(&path).filter(|item| item.is_absolute()) {
        for name in GIT_NAMES {
            let candidate = directory.join(name);
            if !candidate.is_file() {
                continue;
            }
            let candidate = std::fs::canonicalize(&candidate).unwrap_or(candidate);
            let candidate = normalize_local_path(&candidate)?;
            if ensure_child_path(working_dir, &candidate).is_ok() {
                continue;
            }
            return Ok(candidate);
        }
    }
    Err(AppError::internal("未找到可信的 Git 可执行文件"))
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
