use std::{path::Path, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::mpsc,
};

use crate::error::AppError;

use super::ValidationRunStatus;

const OUTPUT_LIMIT: usize = 4_096;
const VALIDATION_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepositoryValidationCatalog {
    pub commands: Vec<RepositoryValidationCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepositoryValidationCommand {
    pub display: String,
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogCommandResult {
    pub status: ValidationRunStatus,
    pub exit_code: Option<i32>,
    pub output_summary: String,
}

impl RepositoryValidationCatalog {
    pub fn discover(root: &Path) -> Result<Self, AppError> {
        Self::discover_with_scope(root, true)
    }

    pub fn discover_for_scope(root: &Path, scope_hints: &[String]) -> Result<Self, AppError> {
        let needs_build = scope_hints.is_empty()
            || scope_hints.iter().any(|path| {
                let path = path.to_ascii_lowercase();
                path.starts_with("src")
                    || path.starts_with("frontend")
                    || path.starts_with("web")
                    || [".ts", ".tsx", ".js", ".jsx", ".css", ".html"]
                        .iter()
                        .any(|suffix| path.ends_with(suffix))
            });
        Self::discover_with_scope(root, needs_build)
    }

    fn discover_with_scope(root: &Path, needs_build: bool) -> Result<Self, AppError> {
        let mut commands = vec![command("git diff --check", "git", &["diff", "--check"])];

        if root.join("package.json").is_file() {
            let package = std::fs::read(root.join("package.json"))?;
            let value: serde_json::Value = serde_json::from_slice(&package)?;
            let scripts = value.get("scripts").and_then(serde_json::Value::as_object);
            let has = |name: &str| scripts.is_some_and(|scripts| scripts.contains_key(name));
            let mut node_commands = Vec::new();
            if has("check") {
                node_commands.push(npm_command("check"));
            } else {
                if has("typecheck") {
                    node_commands.push(npm_command("typecheck"));
                }
                if has("lint") {
                    node_commands.push(npm_command("lint"));
                }
            }
            if has("test") {
                node_commands.push(npm_command("test"));
            }
            if needs_build && has("build") {
                node_commands.push(npm_command("build"));
            }
            commands.extend(node_commands.into_iter().take(3));
        }

        if root.join("Cargo.toml").is_file() {
            commands.push(command("cargo test", "cargo", &["test"]));
            if repository_uses_clippy(root)? {
                commands.push(command(
                    "cargo clippy --all-targets --all-features -- -D warnings",
                    "cargo",
                    &[
                        "clippy",
                        "--all-targets",
                        "--all-features",
                        "--",
                        "-D",
                        "warnings",
                    ],
                ));
            }
        }
        if has_pytest(root) {
            commands.push(command("pytest", "pytest", &[]));
        }
        if root.join("go.mod").is_file() {
            commands.push(command("go test ./...", "go", &["test", "./..."]));
        }
        dedupe_commands(&mut commands);
        Ok(Self { commands })
    }

    pub fn contains_exact(&self, command: &str) -> bool {
        self.commands.iter().any(|entry| entry.display == command)
    }
}

pub async fn execute_catalog_command(
    root: &Path,
    command: &RepositoryValidationCommand,
) -> CatalogCommandResult {
    execute_catalog_command_with_idle(root, command, VALIDATION_IDLE_TIMEOUT).await
}

async fn execute_catalog_command_with_idle(
    root: &Path,
    command: &RepositoryValidationCommand,
    idle_timeout: Duration,
) -> CatalogCommandResult {
    let (program, args) = platform_command(command);
    let mut child = match Command::new(program)
        .args(args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return CatalogCommandResult {
                status: ValidationRunStatus::Unavailable,
                exit_code: None,
                output_summary: format!("命令不可用：{}", command.program),
            };
        }
        Err(error) => {
            return CatalogCommandResult {
                status: ValidationRunStatus::Unavailable,
                exit_code: None,
                output_summary: format!("命令启动失败：{error}"),
            };
        }
    };
    let (sender, mut receiver) = mpsc::unbounded_channel();
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(read_validation_stream(stdout, sender.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(read_validation_stream(stderr, sender.clone()));
    }
    drop(sender);
    let mut output = Vec::new();
    loop {
        match tokio::time::timeout(idle_timeout, receiver.recv()).await {
            Ok(Some(Ok(chunk))) => append_limited(&mut output, &chunk),
            Ok(Some(Err(error))) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return CatalogCommandResult {
                    status: ValidationRunStatus::Unavailable,
                    exit_code: None,
                    output_summary: format!("读取验证输出失败：{error}"),
                };
            }
            Ok(None) => {
                let status = match child.wait().await {
                    Ok(status) => status,
                    Err(error) => {
                        return CatalogCommandResult {
                            status: ValidationRunStatus::Unavailable,
                            exit_code: None,
                            output_summary: format!("等待验证命令失败：{error}"),
                        };
                    }
                };
                let summary = String::from_utf8_lossy(&output).into_owned();
                return CatalogCommandResult {
                    status: if status.success() {
                        ValidationRunStatus::Passed
                    } else {
                        ValidationRunStatus::Failed
                    },
                    exit_code: status.code(),
                    output_summary: summary,
                };
            }
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return CatalogCommandResult {
                    status: ValidationRunStatus::Unavailable,
                    exit_code: None,
                    output_summary: format!(
                        "验证命令连续 {} 秒没有输出，已停止等待",
                        idle_timeout.as_secs()
                    ),
                };
            }
        }
    }
}

async fn read_validation_stream<R>(
    mut reader: R,
    sender: mpsc::UnboundedSender<Result<Vec<u8>, String>>,
) where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 4_096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                if sender.send(Ok(buffer[..read].to_vec())).is_err() {
                    break;
                }
            }
            Err(error) => {
                let _ = sender.send(Err(error.to_string()));
                break;
            }
        }
    }
}

fn append_limited(output: &mut Vec<u8>, chunk: &[u8]) {
    let remaining = OUTPUT_LIMIT.saturating_sub(output.len());
    output.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
}

fn command(display: &str, program: &str, args: &[&str]) -> RepositoryValidationCommand {
    RepositoryValidationCommand {
        display: display.to_owned(),
        program: program.to_owned(),
        args: args.iter().map(|value| (*value).to_owned()).collect(),
    }
}

fn npm_command(script: &str) -> RepositoryValidationCommand {
    command(&format!("npm run {script}"), "npm", &["run", script])
}

fn platform_command(command: &RepositoryValidationCommand) -> (String, Vec<String>) {
    if cfg!(windows) && command.program == "npm" {
        let mut args = vec![
            "/D".to_owned(),
            "/S".to_owned(),
            "/C".to_owned(),
            "npm".to_owned(),
        ];
        args.extend(command.args.clone());
        ("cmd.exe".to_owned(), args)
    } else {
        (command.program.clone(), command.args.clone())
    }
}

fn repository_uses_clippy(root: &Path) -> Result<bool, AppError> {
    let candidates = [
        root.join(".pre-commit-config.yaml"),
        root.join(".github/workflows"),
        root.join(".gitlab-ci.yml"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            if std::fs::read_to_string(&candidate)?.contains("cargo clippy") {
                return Ok(true);
            }
        } else if candidate.is_dir() {
            for entry in std::fs::read_dir(candidate)? {
                let path = entry?.path();
                if path.is_file()
                    && std::fs::read_to_string(path)
                        .is_ok_and(|content| content.contains("cargo clippy"))
                {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

fn has_pytest(root: &Path) -> bool {
    ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"]
        .iter()
        .any(|name| root.join(name).is_file())
        || root.join("tests").is_dir()
}

fn dedupe_commands(commands: &mut Vec<RepositoryValidationCommand>) {
    let mut seen = std::collections::HashSet::new();
    commands.retain(|command| seen.insert(command.display.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_catalog_uses_existing_scripts_not_invented_commands() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("package.json"),
            r#"{"scripts":{"check":"x","test":"x","build":"x","lint":"x"}}"#,
        )
        .unwrap();
        let catalog = RepositoryValidationCatalog::discover(root.path()).unwrap();
        assert!(catalog.contains_exact("git diff --check"));
        assert!(catalog.contains_exact("npm run check"));
        assert!(catalog.contains_exact("npm run test"));
        assert!(catalog.contains_exact("npm run build"));
        assert!(!catalog.contains_exact("npm run lint"));
    }

    #[test]
    fn grep_is_never_a_catalog_gate() {
        let root = tempfile::tempdir().unwrap();
        let catalog = RepositoryValidationCatalog::discover(root.path()).unwrap();
        assert!(!catalog.contains_exact("rg stagger-delay"));
    }

    #[test]
    fn build_is_only_selected_for_source_or_frontend_scope() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("package.json"),
            r#"{"scripts":{"check":"x","build":"x"}}"#,
        )
        .unwrap();
        let docs = RepositoryValidationCatalog::discover_for_scope(
            root.path(),
            &["docs/guide.md".to_owned()],
        )
        .unwrap();
        let source = RepositoryValidationCatalog::discover_for_scope(
            root.path(),
            &["frontend/src/App.tsx".to_owned()],
        )
        .unwrap();
        assert!(!docs.contains_exact("npm run build"));
        assert!(source.contains_exact("npm run build"));
    }

    #[test]
    fn empty_scope_conservatively_keeps_existing_build_gate() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("package.json"),
            r#"{"scripts":{"check":"x","build":"x"}}"#,
        )
        .unwrap();

        let catalog = RepositoryValidationCatalog::discover_for_scope(root.path(), &[]).unwrap();

        assert!(catalog.contains_exact("npm run build"));
    }
}
