use std::{
    io,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::mpsc,
    time::Duration,
};

use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::oneshot,
    task::JoinHandle,
};

const VITE_PORT: u16 = 5173;
const VITE_READY_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ViteCommandSpec {
    node: PathBuf,
    vite_js: PathBuf,
    args: Vec<String>,
    api_url: String,
}

pub struct ManagedVite {
    logs: mpsc::Receiver<String>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    supervisor: JoinHandle<()>,
}

impl ManagedVite {
    pub fn logs(&self) -> &mpsc::Receiver<String> {
        &self.logs
    }

    pub async fn shutdown(mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), self.supervisor).await;
    }
}

pub fn start(frontend_dir: &Path, backend_url: &str) -> io::Result<ManagedVite> {
    let spec = vite_command_spec(frontend_dir, backend_url)?;
    let mut command = Command::new(&spec.node);
    command
        .arg(&spec.vite_js)
        .args(&spec.args)
        .current_dir(frontend_dir)
        .env("RACCOON_API_URL", &spec.api_url)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|error| {
        io::Error::new(error.kind(), format!("无法启动 Vite dev server：{error}"))
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (log_tx, log_rx) = mpsc::channel();

    let mut readers = Vec::new();
    if let Some(stdout) = stdout {
        readers.push(spawn_log_reader(stdout, log_tx.clone(), None));
    }
    if let Some(stderr) = stderr {
        readers.push(spawn_log_reader(stderr, log_tx.clone(), Some("stderr")));
    }
    let _ = log_tx.send(format!(
        "Vite dev server starting: {}",
        spec.vite_js.display()
    ));

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let supervisor = tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                let message = match status {
                    Ok(status) => format!("Vite exited with {status}"),
                    Err(error) => format!("Vite wait failed: {error}"),
                };
                let _ = log_tx.send(message);
            }
            _ = shutdown_rx => {
                let _ = child.start_kill();
                match tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await {
                    Ok(Ok(status)) => {
                        let _ = log_tx.send(format!("Vite stopped with {status}"));
                    }
                    Ok(Err(error)) => {
                        let _ = log_tx.send(format!("Vite stop failed: {error}"));
                    }
                    Err(_) => {
                        let _ = log_tx.send("Vite stop timed out".to_owned());
                    }
                }
            }
        }
        for reader in readers {
            reader.abort();
        }
    });

    Ok(ManagedVite {
        logs: log_rx,
        shutdown_tx: Some(shutdown_tx),
        supervisor,
    })
}

/// 等待被管理的 Vite dev server 在 `127.0.0.1:VITE_PORT` 接受 TCP 连接。
///
/// 每隔 `VITE_READY_POLL_INTERVAL` 探测一次，最多持续 `timeout_seconds` 秒。
/// 就绪返回 `true`，超时返回 `false`。
pub async fn wait_until_ready(timeout_seconds: u64) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], VITE_PORT));
    wait_until_ready_at(
        address,
        Duration::from_secs(timeout_seconds),
        VITE_READY_POLL_INTERVAL,
    )
    .await
}

async fn wait_until_ready_at(address: SocketAddr, timeout: Duration, interval: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        if let Ok(Ok(_)) =
            tokio::time::timeout(interval, tokio::net::TcpStream::connect(address)).await
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(interval).await;
    }
}

fn spawn_log_reader<R>(
    reader: R,
    log_tx: mpsc::Sender<String>,
    stream: Option<&'static str>,
) -> JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim_end().to_owned();
            if line.is_empty() {
                continue;
            }
            let message = match stream {
                Some(stream) => format!("[{stream}] {line}"),
                None => line,
            };
            if log_tx.send(message).is_err() {
                break;
            }
        }
    })
}

fn vite_command_spec(frontend_dir: &Path, backend_url: &str) -> io::Result<ViteCommandSpec> {
    let vite_js = vite_entry(frontend_dir);
    if !vite_js.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("未找到 Vite 入口：{}", vite_js.display()),
        ));
    }
    Ok(ViteCommandSpec {
        node: node_path(),
        vite_js,
        args: vec![
            "--host".to_owned(),
            "0.0.0.0".to_owned(),
            "--port".to_owned(),
            VITE_PORT.to_string(),
            "--strictPort".to_owned(),
        ],
        api_url: backend_url.to_owned(),
    })
}

fn node_path() -> PathBuf {
    std::env::var_os("RACCOON_DEV_NODE_EXEC_PATH")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn vite_entry(frontend_dir: &Path) -> PathBuf {
    frontend_dir
        .join("node_modules")
        .join("vite")
        .join("bin")
        .join("vite.js")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vite_entry_uses_pathbuf_segments() {
        let path = vite_entry(Path::new("frontend"));
        assert!(
            path.ends_with(
                Path::new("node_modules")
                    .join("vite")
                    .join("bin")
                    .join("vite.js")
            )
        );
    }

    #[test]
    fn missing_vite_entry_returns_clear_error() {
        let temp = tempfile::tempdir().unwrap();
        let error = vite_command_spec(temp.path(), "http://127.0.0.1:3001").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(error.to_string().contains("未找到 Vite 入口"));
    }

    #[test]
    fn command_spec_contains_expected_vite_args_and_backend_url() {
        let temp = tempfile::tempdir().unwrap();
        let vite_js = vite_entry(temp.path());
        std::fs::create_dir_all(vite_js.parent().unwrap()).unwrap();
        std::fs::write(&vite_js, "").unwrap();

        let spec = vite_command_spec(temp.path(), "http://127.0.0.1:3002").unwrap();

        assert_eq!(spec.vite_js, vite_js);
        assert!(
            spec.args
                .windows(2)
                .any(|args| args == ["--host", "0.0.0.0"])
        );
        assert!(spec.args.windows(2).any(|args| args == ["--port", "5173"]));
        assert!(spec.args.iter().any(|arg| arg == "--strictPort"));
        assert_eq!(spec.api_url, "http://127.0.0.1:3002");
    }

    #[tokio::test]
    async fn wait_until_ready_at_returns_true_when_port_accepts() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();

        assert!(
            wait_until_ready_at(address, Duration::from_secs(5), Duration::from_millis(10)).await
        );
    }

    #[tokio::test]
    async fn wait_until_ready_at_returns_false_on_timeout() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);

        assert!(
            !wait_until_ready_at(
                address,
                Duration::from_millis(50),
                Duration::from_millis(10)
            )
            .await
        );
    }
}
