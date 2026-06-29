pub struct PiRpcIo {
    pub stdin: ChildStdin,
    pub stdout: BufReader<ChildStdout>,
    pub child: Child,
    /// Set to true to cancel an ongoing Pi Agent session.
    pub cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub struct PiRpcClient {
    pub io: tokio::sync::Mutex<PiRpcIo>,
    pub session_dir: PathBuf,
    pub working_dir: PathBuf,
    pub cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
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

        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let client = Self {
            io: tokio::sync::Mutex::new(PiRpcIo {
                stdin,
                stdout: BufReader::new(stdout),
                child,
                cancelled: cancelled.clone(),
            }),
            session_dir: session_dir.to_path_buf(),
            working_dir: working_dir.to_path_buf(),
            cancelled,
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
        self.prompt_with_images(&build_requirement_prompt(&input), &input.prompt_images)
            .await?;
        let mut pi_events = Vec::new();
        self.wait_for_agent_end_with_events(
            Duration::from_secs(120),  // first warning at 120s
            Duration::from_secs(600),  // hard stop at 600s (10 min)
            &events,
            |event| {
                if let Some(emitter) = &events {
                    emitter.emit_pi_event(event.clone());
                }
                pi_events.push(event);
            },
        )
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
        let response = self
            .prompt_and_extract_response(
                &build_requirement_plan_prompt(&input.requirement),
                Duration::from_secs(600),
                Duration::from_secs(600),
                &events,
                false,
            )
            .await?;
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
            let mut response = self
                .prompt_and_extract_response(
                    &build_recovery_guidance_prompt(&input.task),
                    timeout,
                    timeout,
                    &events,
                    session_reused,
                )
                .await?;
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
        let mut response = self
            .prompt_and_extract_response(
                &build_requirement_task_prompt(&input.requirement, &input.plan, &input.task),
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
        let mut output = match parse_task_execution_output(
            &response.assistant_text,
            response.trace.clone(),
        ) {
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
                    match parse_task_execution_output(&response.assistant_text, response.trace.clone())
                    {
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
            &crate::project_chat::build_project_chat_prompt(&input, session_reused),
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
        self.send_command(json!({
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
        let mut command = json!({
            "type": "prompt",
            "message": message
        });
        if !images.is_empty() {
            command["images"] = json!(
                images
                    .iter()
                    .map(|image| json!({
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

    async fn prompt_and_extract_response(
        &self,
        prompt: &str,
        warning_after: Duration,
        idle_timeout: Duration,
        events: &Option<RequirementEventEmitter>,
        session_reused: bool,
    ) -> Result<crate::requirement_analysis::PiResponseExtraction, AppError> {
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
                    if value.get("type") == Some(&json!("response")) {
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
        command["id"] = json!(&request_id);

        let mut io = self.io.lock().await;
        // Per-request timeout: 30s for all Pi RPC commands.
        let request_id_for_log = request_id.clone();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            Self::send_command_inner(&mut io, request_id, command),
        )
        .await;

        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(error),
            Err(_timeout) => {
                // Timed out — kill the child so the caller (or heartbeat) can restart.
                let _ = io.child.start_kill();
                tracing::error!(
                    "Pi Agent RPC request {request_id_for_log} timed out after 30s"
                );
                Err(AppError::internal("Pi Agent RPC 请求超时"))
            }
        }
    }

    /// Inner write + read-response loop. Called with `io` already locked.
    async fn send_command_inner(
        io: &mut PiRpcIo,
        request_id: String,
        command: Value,
    ) -> Result<Value, AppError> {
        io.stdin
            .write_all(command.to_string().as_bytes())
            .await?;
        io.stdin.write_all(b"\n").await?;
        io.stdin.flush().await?;

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
        let mut io = self.io.lock().await;
        let _ = io.child.start_kill();
        let _ = io.child.wait().await;
    }

    /// Check whether this client has been cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    async fn shutdown(&self) {
        let mut io = self.io.lock().await;
        let _ = io.child.start_kill();
        let _ = io.child.wait().await;
    }
}
