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
    pub managed_run_root: PathBuf,
    pub worktree: PathBuf,
    pub branch: String,
    pub base_head: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemGitWorkspace {
    pub work_item_id: String,
    pub worktree: PathBuf,
    pub branch: String,
    pub base_commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationCommandResult {
    pub exit_code: Option<i32>,
    pub output_summary: String,
    pub idle_timed_out: bool,
}

pub async fn clean_project_base(project_path: &str) -> Result<String, AppError> {
    let project_root = resolve_git_root(Some(Path::new(project_path)), Path::new(project_path))?;
    let branch = git_output(
        &project_root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .await?;
    if branch.trim().is_empty() {
        return Err(AppError::conflict(
            "当前项目处于 detached HEAD，不能干净重建",
        ));
    }
    let status = git_output(
        &project_root,
        &["status", "--porcelain=v2", "--untracked-files=all"],
    )
    .await?;
    if !status.trim().is_empty() {
        return Err(AppError::conflict(
            "当前项目工作区不干净，不能从当前 base 重建 WorkflowRun",
        ));
    }
    for marker in ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REBASE_HEAD"] {
        if git_status(&project_root, &["rev-parse", "--verify", "--quiet", marker])
            .await?
            .success()
        {
            return Err(AppError::conflict(format!(
                "当前项目存在未完成的 Git 操作：{marker}"
            )));
        }
    }
    for state_dir in ["rebase-merge", "rebase-apply"] {
        let marker_path =
            git_output(&project_root, &["rev-parse", "--git-path", state_dir]).await?;
        let marker_path = PathBuf::from(marker_path.trim());
        let marker_path = if marker_path.is_absolute() {
            marker_path
        } else {
            project_root.join(marker_path)
        };
        if marker_path.exists() {
            return Err(AppError::conflict(format!(
                "当前项目存在未完成的 Git 操作：{state_dir}"
            )));
        }
    }
    Ok(git_output(&project_root, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_owned())
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
    let managed_run_root = worktree_root.join(run_id);
    ensure_child_path(&worktree_root, &managed_run_root)?;
    let legacy_worktree = managed_run_root.join(".git").exists();
    let worktree = if legacy_worktree {
        managed_run_root.clone()
    } else {
        managed_run_root.join("integration")
    };
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
        std::fs::create_dir_all(&managed_run_root)?;
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
        managed_run_root,
        worktree,
        branch,
        base_head: base_head.trim().to_owned(),
    })
}

pub async fn prepare_item_workspace(
    integration: &IntegrationWorkspace,
    run_id: &str,
    work_item_id: &str,
    position: u32,
) -> Result<ItemGitWorkspace, AppError> {
    let item_root = integration.managed_run_root.join("items");
    let worktree = item_root.join(format!("item-{position:03}"));
    ensure_child_path(&integration.managed_run_root, &worktree)?;
    let branch = format!("raccoon/workflow-{run_id}-item-{position:03}");
    let base_commit = git_output(&integration.worktree, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_owned();
    if worktree.exists() {
        let actual_branch = git_output(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
        if actual_branch.trim() != branch {
            return Err(AppError::conflict(format!(
                "受管 item worktree 分支不匹配：预期 {branch}，实际 {}",
                actual_branch.trim()
            )));
        }
    } else {
        std::fs::create_dir_all(&item_root)?;
        let worktree_text = worktree
            .to_str()
            .ok_or_else(|| AppError::bad_request("item worktree 路径不是有效 UTF-8"))?;
        let branch_ref = format!("refs/heads/{branch}");
        if git_status(
            &integration.project_root,
            &["show-ref", "--verify", "--quiet", &branch_ref],
        )
        .await?
        .success()
        {
            git_success(
                &integration.project_root,
                &["worktree", "add", worktree_text, &branch],
            )
            .await?;
        } else {
            git_success(
                &integration.project_root,
                &[
                    "worktree",
                    "add",
                    "-b",
                    &branch,
                    worktree_text,
                    &base_commit,
                ],
            )
            .await?;
        }
    }
    Ok(ItemGitWorkspace {
        work_item_id: work_item_id.to_owned(),
        worktree,
        branch,
        base_commit,
    })
}

pub async fn commit_item_workspace(
    workspace: &ItemGitWorkspace,
    title: &str,
) -> Result<String, AppError> {
    stage_integration_changes(&workspace.worktree).await?;
    commit_integration_checkpoint(&workspace.worktree, title).await
}

pub async fn commit_changed_paths(
    working_dir: &Path,
    commit: &str,
) -> Result<Vec<String>, AppError> {
    let output = git_output(
        working_dir,
        &["diff-tree", "--no-commit-id", "--name-only", "-r", commit],
    )
    .await?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

pub async fn cherry_pick_item_commit(
    integration: &IntegrationWorkspace,
    commit: &str,
) -> Result<(), AppError> {
    let output = git_command(&integration.worktree, &["cherry-pick", commit])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    if output.status.success() {
        return Ok(());
    }
    let _ = git_status(&integration.worktree, &["cherry-pick", "--abort"]).await;
    Err(AppError::conflict(format!(
        "item commit 无法无冲突汇入 integration：{}",
        String::from_utf8_lossy(&output.stderr).trim()
    )))
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
    let status = git_output(
        worktree,
        &["status", "--porcelain=v2", "--untracked-files=all"],
    )
    .await?;
    let mut hash = 0xcbf29ce484222325u64;
    for section in [&head, &branch, &staged, &unstaged, &status] {
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

pub async fn clean_integration_fingerprint(
    workspace: &IntegrationWorkspace,
) -> Result<String, AppError> {
    let branch = git_output(&workspace.worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if branch.trim() != workspace.branch {
        return Err(AppError::conflict(format!(
            "integration worktree 分支不匹配：预期 {}，实际 {}",
            workspace.branch,
            branch.trim()
        )));
    }
    let status = git_output(
        &workspace.worktree,
        &["status", "--porcelain=v2", "--untracked-files=all"],
    )
    .await?;
    if !status.trim().is_empty() {
        return Err(AppError::conflict(
            "integration worktree 存在非调度器改动，已阻止新的 Agent 调用",
        ));
    }
    for reference in ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REBASE_HEAD"] {
        if git_status(
            &workspace.worktree,
            &["rev-parse", "--verify", "--quiet", reference],
        )
        .await?
        .success()
        {
            return Err(AppError::conflict(format!(
                "integration worktree 存在未结束的 {reference} 操作"
            )));
        }
    }
    for state_dir in ["rebase-merge", "rebase-apply"] {
        let path = git_output(&workspace.worktree, &["rev-parse", "--git-path", state_dir]).await?;
        let path = PathBuf::from(path.trim());
        let path = if path.is_absolute() {
            path
        } else {
            workspace.worktree.join(path)
        };
        if path.exists() {
            return Err(AppError::conflict(format!(
                "integration worktree 存在未结束的 {state_dir} 操作"
            )));
        }
    }
    worktree_fingerprint(&workspace.worktree).await
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

pub async fn push_workflow_branch(workspace: &IntegrationWorkspace) -> Result<String, AppError> {
    let head = git_output(&workspace.worktree, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_owned();
    git_success(
        &workspace.worktree,
        &["push", "--set-upstream", "origin", &workspace.branch],
    )
    .await?;
    Ok(head)
}

pub async fn sync_local_target_branch(
    workspace: &IntegrationWorkspace,
    target_branch: &str,
    expected_local_head: &str,
) -> Result<String, String> {
    let current_branch = git_output(
        &workspace.project_root,
        &["rev-parse", "--abbrev-ref", "HEAD"],
    )
    .await
    .map_err(|error| error.to_string())?;
    if current_branch.trim() != target_branch {
        return Err(format!(
            "本地主工作区位于 {}，目标分支为 {target_branch}，跳过自动同步",
            current_branch.trim()
        ));
    }
    let root_head = git_output(&workspace.project_root, &["rev-parse", "HEAD"])
        .await
        .map_err(|error| error.to_string())?;
    if root_head.trim() != expected_local_head {
        return Err("本地主分支 HEAD 已变化，跳过自动同步".to_owned());
    }
    let status = git_output(&workspace.project_root, &["status", "--porcelain=v1"])
        .await
        .map_err(|error| error.to_string())?;
    if !status.trim().is_empty() {
        return Err("本地主工作区存在改动，跳过自动同步".to_owned());
    }
    git_success(&workspace.project_root, &["fetch", "origin", target_branch])
        .await
        .map_err(|error| error.to_string())?;
    let remote_ref = format!("origin/{target_branch}");
    git_success(
        &workspace.project_root,
        &["merge", "--ff-only", &remote_ref],
    )
    .await
    .map_err(|error| format!("本地主分支无法安全快进：{error}"))?;
    git_output(&workspace.project_root, &["rev-parse", "HEAD"])
        .await
        .map(|value| value.trim().to_owned())
        .map_err(|error| error.to_string())
}

pub async fn cleanup_item_workspace(
    integration: &IntegrationWorkspace,
    item: &ItemGitWorkspace,
) -> Result<(), AppError> {
    ensure_managed_branch(&item.branch)?;
    ensure_child_path(&integration.managed_run_root, &item.worktree)?;
    if item.worktree.exists() {
        ensure_clean_worktree(&item.worktree).await?;
        let path = item
            .worktree
            .to_str()
            .ok_or_else(|| AppError::bad_request("item worktree 路径不是有效 UTF-8"))?;
        git_success(&integration.project_root, &["worktree", "remove", path]).await?;
    }
    delete_local_branch_if_present(&integration.project_root, &item.branch).await
}

pub async fn cleanup_workflow_workspace(workspace: &IntegrationWorkspace) -> Result<(), AppError> {
    ensure_managed_branch(&workspace.branch)?;
    let managed_worktree_root = workspace
        .project_root
        .join(".raccoon-node")
        .join("worktrees");
    ensure_child_path(&managed_worktree_root, &workspace.worktree)?;
    if workspace.worktree.exists() {
        ensure_clean_worktree(&workspace.worktree).await?;
        let path = workspace
            .worktree
            .to_str()
            .ok_or_else(|| AppError::bad_request("integration worktree 路径不是有效 UTF-8"))?;
        git_success(&workspace.project_root, &["worktree", "remove", path]).await?;
    }
    delete_local_branch_if_present(&workspace.project_root, &workspace.branch).await?;
    git_success(&workspace.project_root, &["worktree", "prune"]).await?;
    remove_empty_managed_directories(&workspace.managed_run_root)?;
    Ok(())
}

pub async fn cleanup_completed_workflow_workspace(
    workspace: &IntegrationWorkspace,
    expected_commit: &str,
) -> Result<(), AppError> {
    if workspace.worktree.exists() {
        let head = git_output(&workspace.worktree, &["rev-parse", "HEAD"]).await?;
        if head.trim() != expected_commit {
            return Err(AppError::conflict(
                "completed WorkflowRun worktree HEAD 与记录提交不一致，保留现场",
            ));
        }
    } else {
        let branch_ref = format!("refs/heads/{}", workspace.branch);
        if git_status(
            &workspace.project_root,
            &["show-ref", "--verify", "--quiet", &branch_ref],
        )
        .await?
        .success()
        {
            let head = git_output(&workspace.project_root, &["rev-parse", &branch_ref]).await?;
            if head.trim() != expected_commit {
                return Err(AppError::conflict(
                    "completed WorkflowRun 分支与记录提交不一致，保留现场",
                ));
            }
        }
    }
    cleanup_workflow_workspace(workspace).await
}

async fn delete_local_branch_if_present(project_root: &Path, branch: &str) -> Result<(), AppError> {
    let branch_ref = format!("refs/heads/{branch}");
    if git_status(
        project_root,
        &["show-ref", "--verify", "--quiet", &branch_ref],
    )
    .await?
    .success()
    {
        git_success(project_root, &["branch", "-D", branch]).await?;
    }
    Ok(())
}

pub async fn delete_remote_workflow_branch(
    project_root: &Path,
    branch: &str,
) -> Result<(), AppError> {
    ensure_managed_branch(branch)?;
    let remote_ref = format!("refs/heads/{branch}");
    if !git_output(
        project_root,
        &["ls-remote", "--heads", "origin", &remote_ref],
    )
    .await?
    .trim()
    .is_empty()
    {
        git_success(project_root, &["push", "origin", "--delete", branch]).await?;
    }
    if !git_output(
        project_root,
        &["ls-remote", "--heads", "origin", &remote_ref],
    )
    .await?
    .trim()
    .is_empty()
    {
        return Err(AppError::conflict("远端 workflow 源分支仍然存在"));
    }
    Ok(())
}

async fn ensure_clean_worktree(worktree: &Path) -> Result<(), AppError> {
    let status = git_output(worktree, &["status", "--porcelain=v1"]).await?;
    if status.trim().is_empty() {
        Ok(())
    } else {
        Err(AppError::conflict("受管 worktree 存在未提交改动，拒绝清理"))
    }
}

fn ensure_managed_branch(branch: &str) -> Result<(), AppError> {
    if branch.starts_with("raccoon/workflow-") {
        Ok(())
    } else {
        Err(AppError::bad_request("拒绝删除非受管 workflow 分支"))
    }
}

fn remove_empty_managed_directories(run_root: &Path) -> Result<(), AppError> {
    let items = run_root.join("items");
    if items.is_dir() && items.read_dir()?.next().is_none() {
        std::fs::remove_dir(&items)?;
    }
    if run_root.is_dir() && run_root.read_dir()?.next().is_none() {
        std::fs::remove_dir(run_root)?;
    }
    Ok(())
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

pub(crate) async fn git_output(working_dir: &Path, args: &[&str]) -> Result<String, AppError> {
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

pub(crate) async fn git_success(working_dir: &Path, args: &[&str]) -> Result<(), AppError> {
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
        std::fs::write(directory.path().join("untracked.txt"), "new\n").unwrap();
        let untracked = worktree_fingerprint(directory.path()).await.unwrap();
        assert_ne!(staged, untracked);
    }

    #[tokio::test]
    async fn integration_guard_rejects_untracked_agent_changes() {
        let directory = tempdir().unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            git_success(directory.path(), &args).await.unwrap();
        }
        std::fs::write(directory.path().join(".gitignore"), ".raccoon-node/\n").unwrap();
        git_success(directory.path(), &["add", ".gitignore"])
            .await
            .unwrap();
        git_success(directory.path(), &["commit", "-m", "initial"])
            .await
            .unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let data_root = root.join(".raccoon-node");
        std::fs::create_dir_all(data_root.join("worktrees")).unwrap();
        let integration =
            prepare_integration_workspace(&data_root, &root.to_string_lossy(), "guard-untracked")
                .await
                .unwrap();
        assert!(clean_integration_fingerprint(&integration).await.is_ok());
        std::fs::write(integration.worktree.join("leaked.txt"), "changed\n").unwrap();
        assert!(clean_integration_fingerprint(&integration).await.is_err());
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
        cleanup_completed_workflow_workspace(&workspace, &commit)
            .await
            .unwrap();
        cleanup_completed_workflow_workspace(&workspace, &commit)
            .await
            .unwrap();
        assert!(!workspace.worktree.exists());
    }

    #[tokio::test]
    async fn parallel_item_workspaces_are_isolated_and_cleaned_idempotently() {
        let directory = tempdir().unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            git_success(directory.path(), &args).await.unwrap();
        }
        std::fs::write(directory.path().join(".gitignore"), ".raccoon-node/\n").unwrap();
        std::fs::write(directory.path().join("base.txt"), "base\n").unwrap();
        git_success(directory.path(), &["add", ".gitignore", "base.txt"])
            .await
            .unwrap();
        git_success(directory.path(), &["commit", "-m", "initial"])
            .await
            .unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let data_root = root.join(".raccoon-node");
        std::fs::create_dir_all(data_root.join("worktrees")).unwrap();
        let integration =
            prepare_integration_workspace(&data_root, &root.to_string_lossy(), "parallel")
                .await
                .unwrap();
        let first = prepare_item_workspace(&integration, "parallel", "item-a", 0)
            .await
            .unwrap();
        let second = prepare_item_workspace(&integration, "parallel", "item-b", 1)
            .await
            .unwrap();
        assert_ne!(first.worktree, second.worktree);
        std::fs::write(first.worktree.join("a.txt"), "a\n").unwrap();
        std::fs::write(second.worktree.join("b.txt"), "b\n").unwrap();
        let first_commit = commit_item_workspace(&first, "first").await.unwrap();
        let second_commit = commit_item_workspace(&second, "second").await.unwrap();
        cherry_pick_item_commit(&integration, &first_commit)
            .await
            .unwrap();
        cherry_pick_item_commit(&integration, &second_commit)
            .await
            .unwrap();
        assert!(integration.worktree.join("a.txt").exists());
        assert!(integration.worktree.join("b.txt").exists());
        cleanup_item_workspace(&integration, &first).await.unwrap();
        cleanup_item_workspace(&integration, &first).await.unwrap();
        cleanup_item_workspace(&integration, &second).await.unwrap();
        assert!(!first.worktree.exists());
        assert!(!second.worktree.exists());
    }
}
