use std::{
    collections::{BTreeSet, HashMap},
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU8, Ordering},
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
    PiModel, RequirementAnalysisFuture, RequirementAnalysisInput, RequirementAnalysisOutput,
    RequirementEventEmitter, RequirementModelTier, RequirementPlanFuture, RequirementPlanInput,
    RequirementReviewStatus, RequirementTaskExecutionFuture, RequirementTaskExecutionInput,
    RequirementTaskExecutionOutput, RequirementTaskKind, PI_RPC_REQUEST_ID,
};
use crate::requirement_analysis::{
    build_requirement_prompt, extract_pi_response, parse_requirement_analysis, PiResponseFailure,
};
use crate::requirement_execution::{
    build_recovery_guidance_prompt, build_requirement_plan_prompt, build_requirement_task_prompt,
    parse_recovery_guidance, parse_requirement_plan, parse_task_execution_output,
};
use crate::utils::{ensure_child_path, normalize_local_path};

const MAX_PROJECT_CLIENTS: usize = 5;

pub struct PiRpcModelProvider {
    pub data_root: PathBuf,
    pub session_dir: PathBuf,
    pub global_client: Arc<tokio::sync::RwLock<Option<Arc<PiRpcClient>>>>,
    pub project_clients: tokio::sync::Mutex<HashMap<String, (Arc<PiRpcClient>, Instant)>>,
    pub startup_error: Option<String>,
    /// 0=Ready, 1=Reconnecting, 2=Error
    pub rpc_status: Arc<AtomicU8>,
}

const RPC_STATUS_READY: u8 = 0;
const RPC_STATUS_RECONNECTING: u8 = 1;
const RPC_STATUS_ERROR: u8 = 2;

impl PiRpcModelProvider {
    pub async fn start(data_root: PathBuf) -> Self {
        let session_dir = data_root.join("pi-sessions");
        let rpc_status = Arc::new(AtomicU8::new(RPC_STATUS_ERROR));
        let (global_client, startup_error) =
            match PiRpcClient::start(&session_dir, &data_root).await {
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
        let provider = Self {
            data_root,
            session_dir,
            global_client: Arc::new(tokio::sync::RwLock::new(global_client)),
            project_clients: tokio::sync::Mutex::new(HashMap::new()),
            startup_error,
            rpc_status: rpc_status.clone(),
        };
        provider.start_heartbeat(rpc_status);
        provider
    }

    /// Spawn a background task that checks `get_state` every 30s.
    /// On failure: kills the child and restarts the Pi Agent process.
    fn start_heartbeat(&self, status_flag: Arc<AtomicU8>) {
        let data_root = self.data_root.clone();
        let session_dir = self.session_dir.clone();
        let global_client_lock = self.global_client.clone(); // Arc<RwLock<...>>
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;

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

                match PiRpcClient::start(&session_dir, &data_root).await {
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
        });
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
    let raw_path = PathBuf::from(local_path);
    let candidates = if raw_path.is_absolute() {
        vec![raw_path]
    } else {
        let mut candidates = Vec::with_capacity(3);
        candidates.push(data_root.join(&raw_path));
        if let Some(workspace_root) = data_root.parent() {
            candidates.push(workspace_root.join(&raw_path));
        }
        candidates.push(raw_path);
        candidates
    };

    let mut first_valid = None;
    for candidate in candidates {
        if ensure_child_path(data_root, &candidate).is_ok() {
            if candidate.exists() {
                return normalize_local_path(&candidate);
            }
            if first_valid.is_none() {
                first_valid = Some(normalize_local_path(&candidate)?);
            }
        }
    }

    first_valid.ok_or_else(|| AppError::bad_request("路径必须位于数据目录内"))
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
                    let session_file = client.get_session_file().await.ok().flatten();
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
}

include!("client.rs");
include!("helpers.rs");
#[cfg(test)]
mod tests;
