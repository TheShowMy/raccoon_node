use std::{
    collections::{BTreeSet, HashMap},
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use crate::error::AppError;
use crate::models::{
    ModelProvider, ModelProviderActionFuture, ModelProviderFuture, ModelSettings, ModelTierSetting,
    PiModel, ProjectChatEventEmitter, ProjectChatFuture, ProjectChatInput, ProjectChatOutput,
    PromptImage, RequirementAnalysisFuture, RequirementAnalysisInput, RequirementAnalysisOutput,
    RequirementEventEmitter, RequirementModelTier, RequirementPlanFuture, RequirementPlanInput,
    RequirementReviewStatus, RequirementTaskExecutionFuture, RequirementTaskExecutionInput,
    RequirementTaskExecutionOutput, RequirementTaskKind, PI_RPC_REQUEST_ID,
};
use crate::requirement_analysis::{
    build_requirement_prompt, extract_pi_response, parse_requirement_analysis, PiResponseFailure,
};
use crate::requirement_execution::{
    build_recovery_guidance_json_repair_prompt, build_recovery_guidance_prompt,
    build_requirement_plan_json_repair_prompt, build_requirement_plan_prompt,
    build_requirement_task_prompt, build_task_output_json_repair_prompt, parse_recovery_guidance,
    parse_requirement_plan, parse_task_execution_output,
};
use crate::utils::{ensure_child_path, normalize_local_path, resolve_git_root};

const MAX_PROJECT_CLIENTS: usize = 5;
const MAX_JSON_REPAIR_ATTEMPTS: usize = 1;

pub struct PiRpcModelProvider {
    pub data_root: PathBuf,
    pub session_dir: PathBuf,
    pub global_client: Arc<tokio::sync::RwLock<Option<Arc<PiRpcClient>>>>,
    pub project_clients: tokio::sync::Mutex<HashMap<String, (Arc<PiRpcClient>, Instant)>>,
    pub startup_error: Option<String>,
    /// 0=Ready, 1=Reconnecting, 2=Error
    pub rpc_status: Arc<AtomicU8>,
    heartbeat_shutdown: Arc<AtomicBool>,
    heartbeat_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

const RPC_STATUS_READY: u8 = 0;
const RPC_STATUS_RECONNECTING: u8 = 1;
const RPC_STATUS_ERROR: u8 = 2;

impl PiRpcModelProvider {
    pub async fn start(data_root: PathBuf) -> Self {
        let session_dir = data_root.join("sessions");
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
            startup_error,
            rpc_status,
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

        let client = PiRpcClient::start(&self.session_dir, &working_dir).await?;
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
            let client = PiRpcClient::start(&self.session_dir, &working_dir).await?;
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
                    let session_file = match error.pi_session_file() {
                        Some(path) => Some(path.to_owned()),
                        None => client.get_session_file().await.ok().flatten(),
                    };
                    return Err(AppError::task_execution(error.to_string(), session_file));
                }
            };
            if input.task.kind == RequirementTaskKind::MergeReview
                && output.review_status == Some(RequirementReviewStatus::Approved)
            {
                let publish = publish_merge_review(&self.data_root, &input, &output).await?;
                output.pull_request_url = Some(publish.pull_request_url);
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
            let working_dir =
                resolve_project_working_dir(&self.data_root, &input.project.local_path)?;
            let client = PiRpcClient::start(&self.session_dir, &working_dir).await?;
            let output = client.ask_project_chat(input, events).await;
            client.shutdown().await;
            output
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

    fn shutdown(&self) -> ModelProviderActionFuture<'_> {
        Box::pin(async move {
            self.shutdown_all().await;
            Ok(())
        })
    }
}

include!("client.rs");
include!("helpers.rs");
#[cfg(test)]
mod tests;
