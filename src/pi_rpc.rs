use std::{
    collections::HashMap,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

use crate::error::AppError;
use crate::models::{
    ModelProvider, ModelProviderFuture, ModelSettings, ModelTierSetting, PiModel,
    RequirementAnalysisFuture, RequirementAnalysisInput, RequirementAnalysisOutput,
    RequirementEventEmitter, RequirementModelTier, RequirementPlanFuture, RequirementPlanInput,
    RequirementReviewStatus, RequirementTaskExecutionFuture, RequirementTaskExecutionInput,
    RequirementTaskExecutionOutput, RequirementTaskKind, PI_RPC_REQUEST_ID,
};
use crate::requirement_analysis::{
    build_pi_trace_metadata, build_requirement_prompt, parse_requirement_analysis,
};
use crate::requirement_execution::{
    build_requirement_plan_prompt, build_requirement_task_prompt, parse_requirement_plan,
    parse_task_execution_output,
};
use crate::utils::ensure_child_path;

const MAX_PROJECT_CLIENTS: usize = 5;

pub struct PiRpcModelProvider {
    pub data_root: PathBuf,
    pub session_dir: PathBuf,
    pub global_client: Option<Arc<PiRpcClient>>,
    pub project_clients: tokio::sync::Mutex<HashMap<String, (Arc<PiRpcClient>, Instant)>>,
    pub startup_error: Option<String>,
}

impl PiRpcModelProvider {
    pub async fn start(data_root: PathBuf) -> Self {
        let session_dir = data_root.join("pi-sessions");
        match PiRpcClient::start(&session_dir, &data_root).await {
            Ok(client) => Self {
                data_root,
                session_dir,
                global_client: Some(Arc::new(client)),
                project_clients: tokio::sync::Mutex::new(HashMap::new()),
                startup_error: None,
            },
            Err(error) => Self {
                data_root,
                session_dir,
                global_client: None,
                project_clients: tokio::sync::Mutex::new(HashMap::new()),
                startup_error: Some(format!(
                    "无法启动 Pi Agent RPC。请确认 'pi' 已安装并在 PATH 中。错误：{}",
                    error
                )),
            },
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
                return Ok(candidate);
            }
            if first_valid.is_none() {
                first_valid = Some(candidate);
            }
        }
    }

    first_valid.ok_or_else(|| AppError::bad_request("路径必须位于数据目录内"))
}

impl ModelProvider for PiRpcModelProvider {
    fn available_models(&self) -> ModelProviderFuture<'_> {
        Box::pin(async move {
            match &self.global_client {
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
            client.execute_requirement_task(input, events).await
        })
    }
}

pub struct PiRpcClient {
    pub io_lock: Mutex<()>,
    pub stdin: Mutex<ChildStdin>,
    pub stdout: Mutex<BufReader<ChildStdout>>,
    pub child: Mutex<Child>,
    pub session_dir: PathBuf,
}

impl PiRpcClient {
    pub async fn start(session_dir: &Path, working_dir: &Path) -> Result<Self, AppError> {
        tokio::fs::create_dir_all(session_dir).await?;

        let candidates: Vec<&str> = if cfg!(target_os = "windows") {
            vec!["pi.cmd", "pi.exe", "pi"]
        } else {
            vec!["pi"]
        };

        let mut last_error = None;
        for program in &candidates {
            match Self::start_with_program(program, session_dir, working_dir).await {
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

    async fn start_with_program(
        program: &str,
        session_dir: &Path,
        working_dir: &Path,
    ) -> Result<Self, AppError> {
        let mut child = Command::new(program)
            .arg("--mode")
            .arg("rpc")
            .arg("--session-dir")
            .arg(session_dir)
            .arg("--no-context-files")
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

        let client = Self {
            io_lock: Mutex::new(()),
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(BufReader::new(stdout)),
            child: Mutex::new(child),
            session_dir: session_dir.to_path_buf(),
        };
        client.drain_startup_noise().await?;
        Ok(client)
    }

    pub async fn get_available_models(&self) -> Result<Vec<PiModel>, AppError> {
        let request_id = format!(
            "raccoon-node-{}",
            PI_RPC_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
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

    pub async fn analyze_requirement(
        &self,
        input: RequirementAnalysisInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<RequirementAnalysisOutput, AppError> {
        if let Some(session_file) = input.pi_session_file.as_deref() {
            let session_path = Path::new(session_file);
            ensure_child_path(&self.session_dir, session_path)?;
            self.switch_session(session_file).await?;
        } else {
            self.new_session().await?;
        }
        self.prepare_high_model(&input.model_settings).await?;
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

    pub async fn plan_requirement_execution(
        &self,
        input: RequirementPlanInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<crate::models::RequirementExecutionPlan, AppError> {
        self.new_session().await?;
        self.prepare_high_model(&input.model_settings).await?;
        self.prompt(&build_requirement_plan_prompt(&input.requirement))
            .await?;
        let mut pi_events = Vec::new();
        self.wait_for_agent_end_with_events(Duration::from_secs(600), |event| {
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
        parse_requirement_plan(&assistant_text)
    }

    pub async fn execute_requirement_task(
        &self,
        input: RequirementTaskExecutionInput,
        events: Option<RequirementEventEmitter>,
    ) -> Result<RequirementTaskExecutionOutput, AppError> {
        if input.task.status == crate::models::RequirementTaskStatus::Fixing {
            if let Some(session_file) = input.task.pi_session_file.as_deref() {
                let session_path = Path::new(session_file);
                ensure_child_path(&self.session_dir, session_path)?;
                self.switch_session(session_file).await?;
            } else {
                self.new_session().await?;
            }
        } else {
            self.new_session().await?;
        }
        self.prepare_model_tier(&input.model_settings, input.task.model_tier)
            .await?;
        self.prompt(&build_requirement_task_prompt(
            &input.requirement,
            &input.plan,
            &input.task,
        ))
        .await?;
        let mut pi_events = Vec::new();
        self.wait_for_agent_end_with_events(
            Duration::from_secs(input.task.timeout_seconds),
            |event| {
                if let Some(emitter) = &events {
                    emitter.emit_pi_event(event.clone());
                }
                pi_events.push(event);
            },
        )
        .await
        .map_err(|error| {
            AppError::internal(format!(
                "节点「{}」执行超时或失败：{error}",
                input.task.title
            ))
        })?;
        let assistant_text = self
            .get_last_assistant_text()
            .await?
            .unwrap_or_else(|| "Pi Agent 没有返回文本。".to_owned());
        let mut output =
            parse_task_execution_output(&assistant_text, build_pi_trace_metadata(&pi_events))?;
        output.pi_session_file = self.get_session_file().await?;
        output.branch_name = input.task.branch_name.clone();
        output.worktree_path = input.task.worktree_path.clone();
        if matches!(
            input.task.kind,
            RequirementTaskKind::Implementation | RequirementTaskKind::MergeReview
        ) {
            output.commit_sha = Some(commit_task_changes(&input.task).await?);
        }
        Ok(output)
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
            let mut saw_tool_execution_this_turn = false;
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
                if value.get("type") == Some(&json!("response")) {
                    continue;
                }

                let event_type = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match event_type {
                    "turn_start" | "agent_start" => saw_tool_execution_this_turn = false,
                    "tool_execution_start" => saw_tool_execution_this_turn = true,
                    "agent_end" => {
                        on_event(value);
                        return Ok(());
                    }
                    "turn_end" if !saw_tool_execution_this_turn => {
                        on_event(value);
                        return Ok(());
                    }
                    _ => {}
                }
                on_event(value);
            }
        };
        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| AppError::internal("等待 Pi Agent 需求分析超时"))?
    }

    async fn send_command_with_auto_id(&self, mut command: Value) -> Result<Value, AppError> {
        let request_id = format!(
            "raccoon-node-{}",
            PI_RPC_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
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

async fn prepare_task_workspace(
    data_root: &Path,
    input: &RequirementTaskExecutionInput,
) -> Result<(PathBuf, Option<String>, Option<PathBuf>), AppError> {
    match input.task.kind {
        RequirementTaskKind::Review => {
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
            ensure_child_path(data_root, &worktree)?;
            if !worktree.exists() {
                return Err(AppError::internal("恢复审核失败：目标 worktree 不存在"));
            }
            if let Some(commit) = reviewed.commit_sha.as_deref() {
                ensure_commit_exists(&worktree, commit).await?;
            }
            Ok((worktree, None, None))
        }
        RequirementTaskKind::Implementation | RequirementTaskKind::MergeReview => {
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
                    task_worktree_path(data_root, &input.project.id, &input.task.id)
                });
            ensure_child_path(data_root, &worktree)?;

            let existed = worktree.join(".git").exists();
            let recovering = input.task.worktree_path.is_some()
                || input.task.branch_name.is_some()
                || input.task.commit_sha.is_some();
            if recovering && !existed {
                return Err(AppError::internal("恢复节点失败：worktree 不存在"));
            }
            if let Some(existing_branch) = input.task.branch_name.as_deref() {
                ensure_branch_exists(&repo, existing_branch).await?;
            }
            if let Some(commit) = input.task.commit_sha.as_deref() {
                ensure_commit_exists(&repo, commit).await?;
            }
            if !existed {
                if let Some(parent) = worktree.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                git(
                    &repo,
                    &[
                        "worktree",
                        "add",
                        "-B",
                        &branch,
                        path_str(&worktree)?,
                        "HEAD",
                    ],
                )
                .await?;
                merge_dependencies(&worktree, input).await?;
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

async fn ensure_commit_exists(repo: &Path, commit: &str) -> Result<(), AppError> {
    let commit_ref = format!("{commit}^{{commit}}");
    git(repo, &["cat-file", "-e", &commit_ref])
        .await
        .map(|_| ())
        .map_err(|_| AppError::internal(format!("恢复节点失败：提交 {commit} 不可达")))
}

async fn merge_dependencies(
    worktree: &Path,
    input: &RequirementTaskExecutionInput,
) -> Result<(), AppError> {
    let dependency_commits = match input.task.kind {
        RequirementTaskKind::Implementation => input
            .task
            .depends_on
            .iter()
            .filter_map(|dependency| {
                input
                    .plan
                    .tasks
                    .iter()
                    .find(|task| task.id == *dependency)
                    .and_then(|task| task.commit_sha.clone())
            })
            .collect::<Vec<_>>(),
        RequirementTaskKind::MergeReview => input
            .plan
            .tasks
            .iter()
            .filter(|task| {
                task.kind == RequirementTaskKind::Implementation
                    && task.review_status == RequirementReviewStatus::Approved
            })
            .filter_map(|task| task.commit_sha.clone())
            .collect::<Vec<_>>(),
        RequirementTaskKind::Review => Vec::new(),
    };

    for commit in dependency_commits {
        git(worktree, &["merge", "--no-ff", "--no-edit", &commit]).await?;
    }
    Ok(())
}

async fn commit_task_changes(
    task: &crate::models::RequirementExecutionTask,
) -> Result<String, AppError> {
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
    } else if task.kind == RequirementTaskKind::Implementation {
        return Err(AppError::internal("实现节点没有产生可提交改动"));
    }
    git(&worktree, &["rev-parse", "HEAD"])
        .await
        .map(|sha| sha.trim().to_owned())
}

async fn git(dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::internal(format!(
        "git {} 失败：{}",
        args.join(" "),
        stderr.trim()
    )))
}

fn task_branch_name(requirement_id: &str, task_id: &str) -> String {
    format!("rn/{}/{}", slug(requirement_id), slug(task_id))
}

fn task_worktree_path(data_root: &Path, project_id: &str, task_id: &str) -> PathBuf {
    data_root
        .join("projects")
        .join(project_id)
        .join("worktrees")
        .join(slug(task_id))
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

impl Drop for PiRpcClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}
