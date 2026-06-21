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
    ModelProvider, ModelProviderFuture, PiModel, RequirementAnalysisFuture,
    RequirementAnalysisInput, RequirementAnalysisOutput, RequirementEventEmitter,
    PI_RPC_REQUEST_ID,
};
use crate::requirement_analysis::{
    build_pi_trace_metadata, build_requirement_prompt, parse_requirement_analysis,
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
            let session_path = Path::new(session_file);
            ensure_child_path(&self.session_dir, session_path)?;
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

impl Drop for PiRpcClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}
