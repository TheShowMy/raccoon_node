use std::{
    collections::{BTreeSet, HashMap},
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
}

pub struct PiRpcClient {
    pub io_lock: Mutex<()>,
    pub stdin: Mutex<ChildStdin>,
    pub stdout: Mutex<BufReader<ChildStdout>>,
    pub child: Mutex<Child>,
    pub session_dir: PathBuf,
    pub working_dir: PathBuf,
}

impl PiRpcClient {
    pub async fn start(session_dir: &Path, working_dir: &Path) -> Result<Self, AppError> {
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
            match Self::start_with_program(program, &session_dir, &working_dir).await {
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
            working_dir: working_dir.to_path_buf(),
        };
        client.drain_startup_noise().await?;
        Ok(client)
    }

    pub async fn get_available_models(&self) -> Result<Vec<PiModel>, AppError> {
        let response = self
            .send_command(json!({
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
        let session_reused = self
            .restore_or_new_session(input.pi_session_file.as_deref())
            .await?;
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

        let response = self.extract_pi_response(&pi_events).await;
        let session_file = self.get_session_file().await?;
        match response {
            Ok(mut response) => {
                response.trace = self
                    .attach_session_usage(response.trace, session_reused)
                    .await;
                Ok(parse_requirement_analysis(
                    &response.assistant_text,
                    session_file,
                    response.trace,
                ))
            }
            Err(mut failure) => {
                failure.trace = self
                    .attach_session_usage(failure.trace, session_reused)
                    .await;
                Ok(requirement_analysis_failure(failure, session_file))
            }
        }
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
        let mut response = self
            .extract_pi_response(&pi_events)
            .await
            .map_err(pi_response_failure_error)?;
        response.trace = self.attach_session_usage(response.trace, false).await;
        parse_requirement_plan(&response.assistant_text)
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
            self.prompt(&build_recovery_guidance_prompt(&input.task))
                .await?;
            let mut guidance_events = Vec::new();
            self.wait_for_agent_end_with_events(
                Duration::from_secs(input.task.timeout_seconds.min(600)),
                |event| {
                    if let Some(emitter) = &events {
                        emitter.emit_pi_event(event.clone());
                    }
                    guidance_events.push(event);
                },
            )
            .await?;
            let mut response = self
                .extract_pi_response(&guidance_events)
                .await
                .map_err(pi_response_failure_error)?;
            response.trace = self
                .attach_session_usage(response.trace, session_reused)
                .await;
            let guidance = parse_recovery_guidance(&response.assistant_text)?;
            return Ok(RequirementTaskExecutionOutput {
                result_summary: "高档模型恢复方案已生成。".to_owned(),
                pi_session_file: self.get_session_file().await?,
                branch_name: input.task.branch_name.clone(),
                worktree_path: input.task.worktree_path.clone(),
                commit_sha: None,
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
        let mut response = self
            .extract_pi_response(&pi_events)
            .await
            .map_err(pi_response_failure_error)?;
        response.trace = self
            .attach_session_usage(response.trace, session_reused)
            .await;
        let mut output = parse_task_execution_output(&response.assistant_text, response.trace)?;
        output.recovery_guidance = input.task.recovery_guidance.clone();
        output.pi_session_file = self.get_session_file().await?;
        output.branch_name = input.task.branch_name.clone();
        output.worktree_path = input.task.worktree_path.clone();
        if matches!(
            input.task.kind,
            RequirementTaskKind::Implementation
                | RequirementTaskKind::BranchMerge
                | RequirementTaskKind::MergeReview
        ) {
            output.commit_sha = Some(commit_task_changes(&input.task, &mut output).await?);
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
        self.send_command(json!({
            "type": "set_model",
            "provider": provider,
            "modelId": model_id
        }))
        .await?;
        Ok(())
    }

    async fn set_thinking_level(&self, level: &str) -> Result<(), AppError> {
        self.send_command(json!({
            "type": "set_thinking_level",
            "level": level
        }))
        .await?;
        Ok(())
    }

    async fn new_session(&self) -> Result<(), AppError> {
        self.send_command(json!({ "type": "new_session" })).await?;
        Ok(())
    }

    async fn restore_or_new_session(&self, session_file: Option<&str>) -> Result<bool, AppError> {
        if let Some(session_file) = session_file {
            let session_path = self.resolve_session_path(session_file)?;
            if tokio::fs::try_exists(&session_path).await? {
                self.switch_session(path_str(&session_path)?).await?;
                return Ok(true);
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
        self.send_command(json!({
            "type": "switch_session",
            "sessionPath": session_path
        }))
        .await?;
        Ok(())
    }

    async fn prompt(&self, message: &str) -> Result<(), AppError> {
        self.send_command(json!({
            "type": "prompt",
            "message": message
        }))
        .await?;
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
            .send_command(json!({ "type": "get_last_assistant_text" }))
            .await?;
        Ok(response
            .get("data")
            .and_then(|data| data.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    async fn get_session_file(&self) -> Result<Option<String>, AppError> {
        let response = self.send_command(json!({ "type": "get_state" })).await?;
        Ok(response
            .get("data")
            .and_then(|data| data.get("sessionFile"))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    async fn get_session_stats(&self) -> Result<Value, AppError> {
        let response = self
            .send_command(json!({ "type": "get_session_stats" }))
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
    ) -> Result<crate::requirement_analysis::PiResponseExtraction, PiResponseFailure> {
        let last_assistant_text =
            self.get_last_assistant_text()
                .await
                .map_err(|error| PiResponseFailure {
                    message: error.to_string(),
                    trace: crate::requirement_analysis::build_pi_trace_metadata(events),
                })?;
        extract_pi_response(events, last_assistant_text)
    }

    async fn wait_for_agent_end_with_events<F>(
        &self,
        timeout: Duration,
        mut on_event: F,
    ) -> Result<(), AppError>
    where
        F: FnMut(Value) + Send,
    {
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
                    if value.get("type") == Some(&json!("response")) {
                        continue;
                    }

                    let terminal = is_terminal_agent_end(&value);
                    on_event(value);
                    if terminal {
                        return Ok(());
                    }
                }
            };
            tokio::time::timeout(timeout, wait)
                .await
                .map_err(|_| AppError::internal("等待 Pi Agent 需求分析超时"))??;
        }
        self.validate_session_working_dir().await
    }

    async fn send_command(&self, mut command: Value) -> Result<Value, AppError> {
        let request_id = format!(
            "raccoon-node-{}",
            PI_RPC_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        command["id"] = json!(&request_id);

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

    async fn shutdown(&self) {
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

fn is_terminal_agent_end(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("agent_end")
        && event.get("willRetry").and_then(Value::as_bool) != Some(true)
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
        json!({
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

fn requirement_analysis_failure(
    failure: PiResponseFailure,
    pi_session_file: Option<String>,
) -> RequirementAnalysisOutput {
    RequirementAnalysisOutput {
        status: crate::models::RequirementStatus::Failed,
        assistant_message: failure.message.clone(),
        progress: String::new(),
        clarifications: Vec::new(),
        draft: None,
        pi_session_file,
        error: Some(failure.message),
        trace: failure.trace,
    }
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
            let worktree = normalize_local_path(&worktree)?;
            ensure_child_path(data_root, &worktree)?;
            if !worktree.exists() {
                return Err(AppError::internal("恢复审核失败：目标 worktree 不存在"));
            }
            let commit = reviewed
                .commit_sha
                .as_deref()
                .ok_or_else(|| AppError::internal("恢复审核失败：审核目标缺少提交"))?;
            ensure_commit_exists(&worktree, commit).await?;
            ensure_head_matches(&worktree, commit).await?;
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
                    task_worktree_path(data_root, &input.project.id, &input.task.id)
                });
            let worktree = normalize_local_path(&worktree)?;
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
                let dependency_commits = task_dependency_commits(input);
                let base_ref = dependency_commits
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
                merge_dependency_commits(&worktree, dependency_commits.into_iter().skip(1)).await?;
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

async fn ensure_head_matches(repo: &Path, expected: &str) -> Result<(), AppError> {
    let head = git(repo, &["rev-parse", "HEAD"]).await?;
    if head.trim() != expected {
        return Err(AppError::internal(format!(
            "恢复审核失败：worktree HEAD {} 与审核提交 {expected} 不一致",
            head.trim()
        )));
    }
    Ok(())
}

fn task_dependency_commits(input: &RequirementTaskExecutionInput) -> Vec<String> {
    dependency_commits_for_task(&input.task, &input.plan)
}

fn dependency_commits_for_task(
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
                    .and_then(|task| task.commit_sha.clone())
            })
            .collect(),
        RequirementTaskKind::Review
        | RequirementTaskKind::ReviewSubAgent
        | RequirementTaskKind::ReviewSummary => Vec::new(),
    }
}

async fn merge_dependency_commits(
    worktree: &Path,
    commits: impl Iterator<Item = String>,
) -> Result<(), AppError> {
    for commit in commits {
        git(worktree, &["merge", "--no-ff", "--no-edit", &commit]).await?;
    }
    Ok(())
}

async fn commit_task_changes(
    task: &crate::models::RequirementExecutionTask,
    output: &mut RequirementTaskExecutionOutput,
) -> Result<String, AppError> {
    let fixing_commit = if task.kind == RequirementTaskKind::Implementation
        && task.status == crate::models::RequirementTaskStatus::Fixing
    {
        Some(
            task.commit_sha
                .as_deref()
                .ok_or_else(|| AppError::internal("修复实现节点缺少旧 commit_sha"))?,
        )
    } else {
        None
    };
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
        if fixing_commit.is_some() {
            return Err(AppError::internal("修复实现节点必须产生实际代码改动"));
        }
        let no_op_reason = output
            .no_op_reason
            .as_deref()
            .map(str::trim)
            .filter(|reason| !reason.is_empty());
        if output.changed == Some(false) {
            if let Some(no_op_reason) = no_op_reason {
                output.execution_warning = Some(format!(
                    "未产生新提交：{no_op_reason}。按 no-op 完成并进入审核。"
                ));
            } else {
                return Err(AppError::internal(
                    "实现节点未产生提交，且缺少 no_op_reason",
                ));
            }
        } else {
            return Err(AppError::internal("实现节点没有产生可提交改动"));
        }
    }
    let commit = git(&worktree, &["rev-parse", "HEAD"])
        .await
        .map(|sha| sha.trim().to_owned())?;
    if fixing_commit == Some(commit.as_str()) {
        return Err(AppError::internal("修复实现节点没有产生新的代码版本"));
    }
    Ok(commit)
}

struct PublishResult {
    pull_request_url: String,
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
    let commit = output
        .commit_sha
        .as_deref()
        .ok_or_else(|| AppError::internal("最终合并节点缺少提交"))?;
    let base_branch = default_branch(&repo).await?;

    git(&repo, &["push", "-u", "origin", branch]).await?;
    let pr_url = ensure_pull_request(&repo, &base_branch, branch, input).await?;
    if !pull_request_is_merged(&repo, &pr_url).await {
        let merge_args = build_pr_merge_args(&pr_url, commit);
        run_gh(
            &repo,
            &merge_args.iter().map(String::as_str).collect::<Vec<_>>(),
        )
        .await?;
    }
    git(&repo, &["fetch", "origin"]).await?;
    git(&repo, &["checkout", &base_branch]).await?;
    git(
        &repo,
        &["reset", "--hard", &format!("origin/{base_branch}")],
    )
    .await?;
    let cleanup_summary = cleanup_requirement_branches(data_root, &repo, input).await;

    Ok(PublishResult {
        pull_request_url: pr_url,
        merged_into: base_branch,
        cleanup_summary,
    })
}

async fn default_branch(repo: &Path) -> Result<String, AppError> {
    let output = git(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .await
    .unwrap_or_default();
    Ok(parse_default_branch(&output))
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

async fn cleanup_requirement_branches(
    data_root: &Path,
    repo: &Path,
    input: &RequirementTaskExecutionInput,
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
        if ensure_child_path(data_root, &worktree).is_ok() && worktree.exists() {
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
        if git(repo, &["push", "origin", "--delete", &branch])
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

async fn git(dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let dir = normalize_local_path(dir)?;
    let output = Command::new("git")
        .arg("-C")
        .arg(&dir)
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

fn task_branch_name(requirement_id: &str, task_id: &str) -> String {
    format!("rn/{}/{}", slug(requirement_id), slug(task_id))
}

fn task_worktree_path(data_root: &Path, project_id: &str, task_id: &str) -> PathBuf {
    data_root
        .join("projects")
        .join(project_id)
        .join("worktrees")
        .join(safe_worktree_name(task_id))
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

impl Drop for PiRpcClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        attach_session_usage, build_pr_merge_args, commit_task_changes,
        dependency_commits_for_task, ensure_head_matches, generated_branch_names,
        is_terminal_agent_end, parse_default_branch, parse_session_header_cwd, safe_worktree_name,
    };
    use crate::models::{
        RequirementExecutionPlan, RequirementModelTier, RequirementReviewStatus,
        RequirementTaskExecutionOutput, RequirementTaskKind, RequirementTaskStatus,
    };
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn parse_default_branch_falls_back_to_main() {
        assert_eq!(parse_default_branch("origin/main\n"), "main");
        assert_eq!(parse_default_branch("origin/trunk\n"), "trunk");
        assert_eq!(parse_default_branch(""), "main");
    }

    #[test]
    fn session_header_requires_absolute_cwd() {
        assert!(parse_session_header_cwd(r#"{"type":"session","cwd":"relative"}"#).is_err());
        assert!(parse_session_header_cwd(r#"{"type":"message","cwd":"/tmp"}"#).is_err());
        let cwd = std::env::current_dir().unwrap();
        let header = json!({ "type": "session", "cwd": cwd }).to_string();
        assert_eq!(
            parse_session_header_cwd(&header).unwrap(),
            std::env::current_dir().unwrap()
        );
    }

    #[test]
    fn worktree_names_avoid_windows_reserved_names_and_long_components() {
        assert_eq!(safe_worktree_name("CON"), "_con");
        assert_eq!(safe_worktree_name("com1"), "_com1");
        let long = safe_worktree_name(&"a".repeat(300));
        assert!(long.len() <= 80);
        assert_ne!(long, safe_worktree_name(&"b".repeat(300)));
    }

    #[test]
    fn pr_merge_args_lock_head_commit_without_deleting_branch() {
        assert_eq!(
            build_pr_merge_args("https://github.com/acme/repo/pull/1", "abc123"),
            vec![
                "pr",
                "merge",
                "https://github.com/acme/repo/pull/1",
                "--merge",
                "--match-head-commit",
                "abc123",
            ]
        );
    }

    #[test]
    fn generated_branch_names_only_keeps_rn_branches() {
        let branches = generated_branch_names(["rn/req/task", "main", "feature/x"].into_iter());
        assert_eq!(
            branches.into_iter().collect::<Vec<_>>(),
            vec!["rn/req/task"]
        );
    }

    #[test]
    fn wait_only_finishes_on_final_agent_end() {
        assert!(!is_terminal_agent_end(&json!({ "type": "turn_end" })));
        assert!(!is_terminal_agent_end(&json!({
            "type": "agent_end",
            "willRetry": true
        })));
        assert!(is_terminal_agent_end(&json!({
            "type": "agent_end",
            "willRetry": false
        })));
        assert!(is_terminal_agent_end(&json!({ "type": "agent_end" })));
    }

    #[test]
    fn session_stats_are_normalized_into_trace_usage() {
        let trace = Some(json!({
            "type": "pi_trace",
            "version": 1,
            "trace": {
                "thinking": "",
                "output": "",
                "tools": [],
                "statuses": []
            }
        }));
        let trace = attach_session_usage(
            trace,
            &json!({
                "assistantMessages": 3,
                "tokens": {
                    "input": 1500,
                    "output": 320,
                    "cacheRead": 1000,
                    "cacheWrite": 240
                },
                "contextUsage": {
                    "tokens": 12000,
                    "contextWindow": 128000,
                    "percent": 9.4
                }
            }),
            true,
        )
        .unwrap();

        assert_eq!(trace["trace"]["usage"]["sessionReused"], true);
        assert_eq!(trace["trace"]["usage"]["callCount"], 3);
        assert_eq!(trace["trace"]["usage"]["cacheRead"], 1000);
        assert_eq!(trace["trace"]["usage"]["context"]["window"], 128000);
    }

    #[test]
    fn dependency_commits_follow_task_dependency_order() {
        let mut task_a = test_task(Path::new("/tmp/a"));
        task_a.id = "task-a".to_owned();
        task_a.commit_sha = Some("commit-a".to_owned());
        let mut task_b = test_task(Path::new("/tmp/b"));
        task_b.id = "task-b".to_owned();
        task_b.commit_sha = Some("commit-b".to_owned());
        let mut task_c = test_task(Path::new("/tmp/c"));
        task_c.id = "task-c".to_owned();
        task_c.depends_on = vec!["task-b".to_owned(), "task-a".to_owned()];
        let plan = RequirementExecutionPlan {
            summary: "plan".to_owned(),
            tasks: vec![task_a, task_b, task_c.clone()],
        };

        assert_eq!(
            dependency_commits_for_task(&task_c, &plan),
            vec!["commit-b", "commit-a"]
        );
    }

    #[tokio::test]
    async fn implementation_no_diff_can_complete_with_no_op_reason() {
        let temp = tempfile::tempdir().unwrap();
        init_repo(temp.path()).await;
        let task = test_task(temp.path());
        let mut output = test_output(Some(false), Some("前置节点已完整实现"));

        let commit = commit_task_changes(&task, &mut output).await.unwrap();

        assert!(!commit.is_empty());
        assert_eq!(
            output.execution_warning.as_deref(),
            Some("未产生新提交：前置节点已完整实现。按 no-op 完成并进入审核。")
        );
    }

    #[tokio::test]
    async fn implementation_no_diff_without_no_op_reason_still_fails() {
        let temp = tempfile::tempdir().unwrap();
        init_repo(temp.path()).await;
        let task = test_task(temp.path());
        let mut output = test_output(None, None);

        let error = commit_task_changes(&task, &mut output).await.unwrap_err();

        assert!(error.to_string().contains("没有产生可提交改动"));
    }

    #[tokio::test]
    async fn fixing_implementation_requires_a_new_commit() {
        let temp = tempfile::tempdir().unwrap();
        init_repo(temp.path()).await;
        let old_commit = super::git(temp.path(), &["rev-parse", "HEAD"])
            .await
            .unwrap()
            .trim()
            .to_owned();
        let mut task = test_task(temp.path());
        task.status = RequirementTaskStatus::Fixing;
        task.commit_sha = Some(old_commit.clone());
        let mut output = test_output(Some(false), Some("无需修改"));

        let error = commit_task_changes(&task, &mut output).await.unwrap_err();
        assert!(error.to_string().contains("必须产生实际代码改动"));

        tokio::fs::write(temp.path().join("README.md"), "fixed\n")
            .await
            .unwrap();
        let new_commit = commit_task_changes(&task, &mut output).await.unwrap();
        assert_ne!(new_commit, old_commit);
    }

    #[tokio::test]
    async fn review_workspace_head_must_match_reviewed_commit() {
        let temp = tempfile::tempdir().unwrap();
        init_repo(temp.path()).await;
        let reviewed_commit = super::git(temp.path(), &["rev-parse", "HEAD"])
            .await
            .unwrap()
            .trim()
            .to_owned();
        tokio::fs::write(temp.path().join("README.md"), "new\n")
            .await
            .unwrap();
        super::git(temp.path(), &["add", "README.md"])
            .await
            .unwrap();
        super::git(temp.path(), &["commit", "-m", "new"])
            .await
            .unwrap();

        let error = ensure_head_matches(temp.path(), &reviewed_commit)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("与审核提交"));
    }

    async fn init_repo(path: &Path) {
        super::git(path, &["init"]).await.unwrap();
        super::git(path, &["config", "user.email", "test@example.com"])
            .await
            .unwrap();
        super::git(path, &["config", "user.name", "Test"])
            .await
            .unwrap();
        tokio::fs::write(path.join("README.md"), "test\n")
            .await
            .unwrap();
        super::git(path, &["add", "README.md"]).await.unwrap();
        super::git(path, &["commit", "-m", "init"]).await.unwrap();
    }

    fn test_task(path: &Path) -> crate::models::RequirementExecutionTask {
        crate::models::RequirementExecutionTask {
            id: "task-1".to_owned(),
            title: "实现功能".to_owned(),
            description: "只做当前功能".to_owned(),
            depends_on: Vec::new(),
            kind: RequirementTaskKind::Implementation,
            model_tier: RequirementModelTier::Medium,
            timeout_seconds: 60,
            pi_session_file: None,
            branch_name: None,
            worktree_path: Some(path.to_string_lossy().to_string()),
            commit_sha: None,
            review_for: None,
            review_angle: None,
            review_status: RequirementReviewStatus::Pending,
            attempt: 0,
            execution_failure_count: 0,
            review_rejection_count: 0,
            recovery_stage: crate::models::RequirementRecoveryStage::None,
            failure_summary: None,
            recovery_guidance: None,
            high_tier_execution_used: false,
            last_review_feedback: None,
            pull_request_url: None,
            merged_into: None,
            cleanup_summary: None,
            execution_warning: None,
            trace: None,
            status: RequirementTaskStatus::Running,
            target_files: Vec::new(),
            result_summary: None,
            error: None,
        }
    }

    fn test_output(
        changed: Option<bool>,
        no_op_reason: Option<&str>,
    ) -> RequirementTaskExecutionOutput {
        RequirementTaskExecutionOutput {
            result_summary: "完成".to_owned(),
            pi_session_file: None,
            branch_name: None,
            worktree_path: None,
            commit_sha: None,
            review_status: None,
            review_feedback: None,
            pull_request_url: None,
            merged_into: None,
            cleanup_summary: None,
            execution_warning: None,
            changed,
            no_op_reason: no_op_reason.map(str::to_owned),
            recovery_guidance: None,
            trace: Some(json!({ "type": "pi_trace" })),
        }
    }
}
