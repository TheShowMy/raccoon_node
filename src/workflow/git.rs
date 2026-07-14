use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::utils::{ensure_child_path, normalize_local_path, resolve_git_root};

const VALIDATION_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_VALIDATION_OUTPUT_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationWorkspace {
    pub project_root: PathBuf,
    pub worktree: PathBuf,
    pub branch: String,
    pub base_head: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationCommandResult {
    pub exit_code: Option<i32>,
    pub output_summary: String,
    pub idle_timed_out: bool,
}

pub async fn prepare_integration_workspace(
    data_root: &Path,
    project_path: &str,
    run_id: &str,
) -> Result<IntegrationWorkspace, AppError> {
    let project_root = resolve_git_root(Some(Path::new(project_path)), Path::new(project_path))?;
    let expected_data_root = project_root.join(".raccoon-node");
    if normalize_local_path(data_root)? != normalize_local_path(&expected_data_root)? {
        return Err(AppError::bad_request(
            "Workflow 数据目录与项目 Git 根目录不一致",
        ));
    }
    let worktree_root = data_root.join("worktrees");
    let worktree = worktree_root.join(run_id);
    ensure_child_path(&worktree_root, &worktree)?;
    let branch = format!("raccoon/workflow-{run_id}");
    let base_head = git_output(&project_root, &["rev-parse", "HEAD"]).await?;

    if worktree.exists() {
        let actual_branch = git_output(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
        if actual_branch.trim() != branch {
            return Err(AppError::conflict(format!(
                "受管 integration worktree 分支不匹配：预期 {branch}，实际 {}",
                actual_branch.trim()
            )));
        }
    } else {
        let branch_exists = git_status(
            &project_root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .await?
        .success();
        let worktree_text = worktree
            .to_str()
            .ok_or_else(|| AppError::bad_request("worktree 路径不是有效 UTF-8"))?;
        if branch_exists {
            git_success(&project_root, &["worktree", "add", worktree_text, &branch]).await?;
        } else {
            git_success(
                &project_root,
                &["worktree", "add", "-b", &branch, worktree_text, "HEAD"],
            )
            .await?;
        }
    }

    Ok(IntegrationWorkspace {
        project_root,
        worktree,
        branch,
        base_head: base_head.trim().to_owned(),
    })
}

pub async fn stage_integration_changes(worktree: &Path) -> Result<(), AppError> {
    git_success(worktree, &["add", "-A"]).await
}

pub async fn staged_integration_diff(worktree: &Path) -> Result<String, AppError> {
    git_output(
        worktree,
        &[
            "diff",
            "--cached",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
        ],
    )
    .await
}

pub async fn worktree_fingerprint(worktree: &Path) -> Result<String, AppError> {
    let head = git_output(worktree, &["rev-parse", "HEAD"]).await?;
    let branch = git_output(worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    let staged = staged_integration_diff(worktree).await?;
    let unstaged = git_output(
        worktree,
        &["diff", "--binary", "--no-ext-diff", "--no-textconv"],
    )
    .await?;
    let mut hash = 0xcbf29ce484222325u64;
    for section in [&head, &branch, &staged, &unstaged] {
        for byte in section
            .len()
            .to_le_bytes()
            .into_iter()
            .chain(section.bytes())
        {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!("git:{hash:016x}"))
}

pub async fn commit_integration_checkpoint(
    worktree: &Path,
    title: &str,
) -> Result<String, AppError> {
    let staged = staged_integration_diff(worktree).await?;
    if staged.trim().is_empty() {
        return git_output(worktree, &["rev-parse", "HEAD"])
            .await
            .map(|value| value.trim().to_owned());
    }
    let message = format!("(feat) {title}");
    git_success(worktree, &["commit", "-m", &message]).await?;
    git_output(worktree, &["rev-parse", "HEAD"])
        .await
        .map(|value| value.trim().to_owned())
}

pub async fn integrate_workflow_branch(
    workspace: &IntegrationWorkspace,
) -> Result<String, AppError> {
    let root_head = git_output(&workspace.project_root, &["rev-parse", "HEAD"]).await?;
    let branch_head = git_output(&workspace.worktree, &["rev-parse", "HEAD"]).await?;
    if root_head.trim() == branch_head.trim() {
        return Ok(root_head.trim().to_owned());
    }
    if root_head.trim() != workspace.base_head {
        return Err(AppError::conflict(
            "主工作区 HEAD 在 WorkflowRun 期间发生变化，不能自动快进合并",
        ));
    }
    let porcelain = git_output(&workspace.project_root, &["status", "--porcelain=v1"]).await?;
    if !porcelain.trim().is_empty() {
        return Err(AppError::conflict(
            "主工作区存在未提交改动，不能自动集成 WorkflowRun",
        ));
    }
    git_success(
        &workspace.project_root,
        &["merge", "--ff-only", &workspace.branch],
    )
    .await?;
    git_output(&workspace.project_root, &["rev-parse", "HEAD"])
        .await
        .map(|value| value.trim().to_owned())
}

pub async fn run_validation_command(
    working_dir: &Path,
    command: &str,
) -> Result<ValidationCommandResult, AppError> {
    if command.trim().is_empty() {
        return Err(AppError::bad_request("验证命令不能为空"));
    }
    let mut process = if cfg!(windows) {
        let mut process = Command::new("cmd.exe");
        process.args(["/D", "/S", "/C", command]);
        process
    } else {
        let mut process = Command::new("/bin/sh");
        process.args(["-lc", command]);
        process
    };
    process
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = process.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::internal("无法读取验证命令 stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::internal("无法读取验证命令 stderr"))?;
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
    spawn_output_reader(stdout, tx.clone());
    spawn_output_reader(stderr, tx.clone());
    drop(tx);

    let mut output = Vec::new();
    let mut idle_timed_out = false;
    loop {
        match tokio::time::timeout(VALIDATION_IDLE_TIMEOUT, rx.recv()).await {
            Ok(Some(chunk)) => append_bounded(&mut output, &chunk),
            Ok(None) => break,
            Err(_) => {
                idle_timed_out = true;
                child.kill().await?;
                break;
            }
        }
    }
    let status = child.wait().await?;
    Ok(ValidationCommandResult {
        exit_code: status.code(),
        output_summary: String::from_utf8_lossy(&output).trim().to_owned(),
        idle_timed_out,
    })
}

fn spawn_output_reader<R>(mut reader: R, tx: mpsc::Sender<Vec<u8>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 4096];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if tx.send(buffer[..read].to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
}

fn append_bounded(output: &mut Vec<u8>, chunk: &[u8]) {
    let remaining = MAX_VALIDATION_OUTPUT_BYTES.saturating_sub(output.len());
    output.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
}

fn git_command(working_dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_WORK_TREE");
    command
}

async fn git_output(working_dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let output = git_command(working_dir, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    if !output.status.success() {
        return Err(AppError::internal(format!(
            "git {} 失败：{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn git_success(working_dir: &Path, args: &[&str]) -> Result<(), AppError> {
    git_output(working_dir, args).await.map(|_| ())
}

async fn git_status(
    working_dir: &Path,
    args: &[&str],
) -> Result<std::process::ExitStatus, AppError> {
    git_command(working_dir, args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn validation_command_captures_status_and_output() {
        let directory = tempdir().unwrap();
        let command = if cfg!(windows) {
            "echo workflow-run"
        } else {
            "printf workflow-run"
        };
        let result = run_validation_command(directory.path(), command)
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert!(result.output_summary.contains("workflow-run"));
        assert!(!result.idle_timed_out);
    }

    #[tokio::test]
    async fn fingerprint_detects_staging_state_changes() {
        let directory = tempdir().unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            git_success(directory.path(), &args).await.unwrap();
        }
        std::fs::write(directory.path().join("file.txt"), "initial\n").unwrap();
        git_success(directory.path(), &["add", "file.txt"])
            .await
            .unwrap();
        git_success(directory.path(), &["commit", "-m", "initial"])
            .await
            .unwrap();
        std::fs::write(directory.path().join("file.txt"), "changed\n").unwrap();
        let unstaged = worktree_fingerprint(directory.path()).await.unwrap();
        git_success(directory.path(), &["add", "file.txt"])
            .await
            .unwrap();
        let staged = worktree_fingerprint(directory.path()).await.unwrap();
        assert_ne!(unstaged, staged);
    }

    #[tokio::test]
    async fn integration_is_idempotent_after_fast_forward_succeeds() {
        let directory = tempdir().unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            git_success(directory.path(), &args).await.unwrap();
        }
        std::fs::write(directory.path().join(".gitignore"), ".raccoon-node/\n").unwrap();
        std::fs::write(directory.path().join("file.txt"), "initial\n").unwrap();
        git_success(directory.path(), &["add", ".gitignore", "file.txt"])
            .await
            .unwrap();
        git_success(directory.path(), &["commit", "-m", "initial"])
            .await
            .unwrap();
        let project_root = std::fs::canonicalize(directory.path()).unwrap();
        let data_root = project_root.join(".raccoon-node");
        std::fs::create_dir_all(data_root.join("worktrees")).unwrap();
        let workspace = prepare_integration_workspace(
            &data_root,
            &project_root.to_string_lossy(),
            "run-idempotent",
        )
        .await
        .unwrap();
        std::fs::write(workspace.worktree.join("file.txt"), "changed\n").unwrap();
        stage_integration_changes(&workspace.worktree)
            .await
            .unwrap();
        let commit = commit_integration_checkpoint(&workspace.worktree, "test")
            .await
            .unwrap();

        assert_eq!(integrate_workflow_branch(&workspace).await.unwrap(), commit);
        assert_eq!(integrate_workflow_branch(&workspace).await.unwrap(), commit);
    }
}
