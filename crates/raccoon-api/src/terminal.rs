use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};

use chrono::Utc;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use raccoon_core::{
    error::AppError,
    models::{TerminalServerMessage, TerminalSession, TerminalSessionStatus},
    utils::resolve_git_root,
};
use tokio::sync::{broadcast, mpsc};

const MAX_TERMINALS_PER_PROJECT: usize = 6;
const MAX_TERMINAL_COMMAND_LEN: usize = 4096;
const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 100;
const MIN_ROWS: u16 = 4;
const MAX_ROWS: u16 = 80;
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 240;
const OUTPUT_CHANNEL_CAPACITY: usize = 512;

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<TerminalSessionRuntime>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self, project_id: &str) -> Vec<TerminalSession> {
        self.sessions
            .lock()
            .expect("terminal session lock poisoned")
            .values()
            .filter_map(|session| {
                let metadata = session.metadata();
                (metadata.project_id == project_id).then_some(metadata)
            })
            .collect()
    }

    pub fn spawn(
        &self,
        project_id: &str,
        project_root: PathBuf,
        command: Option<String>,
        title: Option<String>,
        rows: Option<u16>,
        cols: Option<u16>,
    ) -> Result<TerminalSession, AppError> {
        let project_root = validate_project_root(&project_root)?;
        let command = command
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if command
            .as_deref()
            .is_some_and(|value| value.chars().count() > MAX_TERMINAL_COMMAND_LEN)
        {
            return Err(AppError::bad_request(format!(
                "终端启动命令不能超过 {MAX_TERMINAL_COMMAND_LEN} 个字符"
            )));
        }
        let title = title
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .or_else(|| command.clone())
            .unwrap_or_else(|| "项目终端".to_owned());
        let size = terminal_size(rows, cols);

        let mut sessions = self
            .sessions
            .lock()
            .expect("terminal session lock poisoned");
        let active_count = sessions
            .values()
            .filter(|session| session.project_id == project_id)
            .count();
        if active_count >= MAX_TERMINALS_PER_PROJECT {
            return Err(AppError::bad_request(format!(
                "每个项目最多同时打开 {MAX_TERMINALS_PER_PROJECT} 个终端"
            )));
        }

        let id = format!(
            "terminal-{}-{}",
            Utc::now().timestamp_millis(),
            sessions.len() + 1
        );
        let runtime = TerminalSessionRuntime::spawn(
            id.clone(),
            project_id.to_owned(),
            title,
            command,
            project_root,
            size,
        )?;
        let metadata = runtime.metadata();
        sessions.insert(id, runtime);
        Ok(metadata)
    }

    pub fn get(&self, terminal_id: &str) -> Result<Arc<TerminalSessionRuntime>, AppError> {
        self.sessions
            .lock()
            .expect("terminal session lock poisoned")
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("终端不存在"))
    }

    pub fn delete(&self, project_id: &str, terminal_id: &str) -> Result<(), AppError> {
        let mut sessions = self
            .sessions
            .lock()
            .expect("terminal session lock poisoned");
        let Some(session) = sessions.get(terminal_id).cloned() else {
            return Err(AppError::not_found("终端不存在"));
        };
        if session.project_id != project_id {
            return Err(AppError::not_found("终端不存在"));
        }
        sessions.remove(terminal_id);
        session.shutdown();
        Ok(())
    }

    pub fn cleanup_exited(&self) {
        self.sessions
            .lock()
            .expect("terminal session lock poisoned")
            .retain(|_, session| session.status() != TerminalSessionStatus::Exited);
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.lock() {
            for session in sessions.values() {
                session.shutdown();
            }
        }
    }
}

pub struct TerminalSessionRuntime {
    id: String,
    project_id: String,
    title: String,
    command: Option<String>,
    created_at: chrono::DateTime<Utc>,
    state: Mutex<TerminalSessionState>,
    input_tx: mpsc::UnboundedSender<TerminalInput>,
    output_tx: broadcast::Sender<TerminalServerMessage>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

struct TerminalSessionState {
    status: TerminalSessionStatus,
    exit_code: Option<i32>,
    updated_at: chrono::DateTime<Utc>,
}

enum TerminalInput {
    Data(String),
    Resize(PtySize),
    Shutdown,
}

impl TerminalSessionRuntime {
    fn spawn(
        id: String,
        project_id: String,
        title: String,
        command: Option<String>,
        project_root: PathBuf,
        size: PtySize,
    ) -> Result<Arc<Self>, AppError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|error| AppError::internal(format!("无法创建终端：{error}")))?;
        let mut cmd = shell_command(command.as_deref());
        cmd.cwd(project_root.as_os_str());
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|error| AppError::internal(format!("无法启动终端：{error}")))?;
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| AppError::internal(format!("无法读取终端输出：{error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| AppError::internal(format!("无法写入终端输入：{error}")))?;
        let master = pair.master;
        let killer = child.clone_killer();
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let (output_tx, _) = broadcast::channel(OUTPUT_CHANNEL_CAPACITY);
        let now = Utc::now();
        let runtime = Arc::new(Self {
            id,
            project_id,
            title,
            command,
            created_at: now,
            state: Mutex::new(TerminalSessionState {
                status: TerminalSessionStatus::Running,
                exit_code: None,
                updated_at: now,
            }),
            input_tx,
            output_tx,
            killer: Mutex::new(killer),
        });

        spawn_reader(runtime.clone(), reader);
        spawn_input(runtime.clone(), master, writer, input_rx);
        spawn_waiter(runtime.clone(), child);
        Ok(runtime)
    }

    pub fn metadata(&self) -> TerminalSession {
        let state = self.state.lock().expect("terminal state lock poisoned");
        TerminalSession {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            title: self.title.clone(),
            command: self.command.clone(),
            status: state.status,
            exit_code: state.exit_code,
            created_at: self.created_at,
            updated_at: state.updated_at,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TerminalServerMessage> {
        self.output_tx.subscribe()
    }

    pub fn input(&self, data: String) {
        let _ = self.input_tx.send(TerminalInput::Data(data));
    }

    pub fn resize(&self, rows: u16, cols: u16) {
        let _ = self
            .input_tx
            .send(TerminalInput::Resize(terminal_size(Some(rows), Some(cols))));
    }

    pub fn shutdown(&self) {
        let _ = self.input_tx.send(TerminalInput::Shutdown);
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }

    fn status(&self) -> TerminalSessionStatus {
        self.state
            .lock()
            .expect("terminal state lock poisoned")
            .status
    }

    fn set_exited(&self, exit_code: i32) {
        {
            let mut state = self.state.lock().expect("terminal state lock poisoned");
            state.status = TerminalSessionStatus::Exited;
            state.exit_code = Some(exit_code);
            state.updated_at = Utc::now();
        }
        let _ = self.output_tx.send(TerminalServerMessage::Status {
            status: TerminalSessionStatus::Exited,
            exit_code: Some(exit_code),
        });
    }

    fn emit_error(&self, message: impl Into<String>) {
        let _ = self.output_tx.send(TerminalServerMessage::Error {
            message: message.into(),
        });
    }
}

fn spawn_reader(runtime: Arc<TerminalSessionRuntime>, mut reader: Box<dyn Read + Send>) {
    thread::Builder::new()
        .name(format!("raccoon-terminal-reader-{}", runtime.id))
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        let data = String::from_utf8_lossy(&buffer[..length]).into_owned();
                        let _ = runtime
                            .output_tx
                            .send(TerminalServerMessage::Output { data });
                    }
                    Err(error) => {
                        runtime.emit_error(format!("终端输出读取失败：{error}"));
                        break;
                    }
                }
            }
        })
        .expect("failed to spawn terminal reader thread");
}

fn spawn_input(
    runtime: Arc<TerminalSessionRuntime>,
    master: Box<dyn MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    mut input_rx: mpsc::UnboundedReceiver<TerminalInput>,
) {
    thread::Builder::new()
        .name(format!("raccoon-terminal-input-{}", runtime.id))
        .spawn(move || {
            while let Some(input) = input_rx.blocking_recv() {
                match input {
                    TerminalInput::Data(data) => {
                        if let Err(error) = writer.write_all(data.as_bytes()) {
                            runtime.emit_error(format!("终端输入写入失败：{error}"));
                            break;
                        }
                        let _ = writer.flush();
                    }
                    TerminalInput::Resize(size) => {
                        if let Err(error) = master.resize(size) {
                            runtime.emit_error(format!("终端尺寸调整失败：{error}"));
                        }
                    }
                    TerminalInput::Shutdown => break,
                }
            }
        })
        .expect("failed to spawn terminal input thread");
}

fn spawn_waiter(runtime: Arc<TerminalSessionRuntime>, mut child: Box<dyn Child + Send + Sync>) {
    thread::Builder::new()
        .name(format!("raccoon-terminal-waiter-{}", runtime.id))
        .spawn(move || match child.wait() {
            Ok(status) => runtime.set_exited(status.exit_code() as i32),
            Err(error) => {
                runtime.emit_error(format!("终端进程等待失败：{error}"));
                runtime.set_exited(1);
            }
        })
        .expect("failed to spawn terminal waiter thread");
}

fn validate_project_root(project_root: &Path) -> Result<PathBuf, AppError> {
    let cwd = std::env::current_dir()?;
    resolve_git_root(Some(project_root), &cwd)
}

fn terminal_size(rows: Option<u16>, cols: Option<u16>) -> PtySize {
    PtySize {
        rows: rows.unwrap_or(DEFAULT_ROWS).clamp(MIN_ROWS, MAX_ROWS),
        cols: cols.unwrap_or(DEFAULT_COLS).clamp(MIN_COLS, MAX_COLS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn shell_command(command: Option<&str>) -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut builder = CommandBuilder::new("cmd.exe");
        if let Some(command) = command {
            builder.args(["/D", "/S", "/C", command]);
        }
        builder
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".to_owned());
        let mut builder = CommandBuilder::new(shell);
        if let Some(command) = command {
            builder.args(["-lc", command]);
        }
        builder
    }
}
