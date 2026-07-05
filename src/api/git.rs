use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    path::{Component, Path},
    sync::Arc,
};

use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, process::Command};

use crate::api::AppState;
use crate::error::AppError;
use crate::store::CURRENT_PROJECT_ID;
use crate::utils::normalize_local_path;

const MAX_DIFF_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitFileStatus {
    pub path: String,
    pub original_path: Option<String>,
    pub staged: Option<GitChangeKind>,
    pub unstaged: Option<GitChangeKind>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitStatusResponse {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub branches: Vec<String>,
    pub remote_configured: bool,
    pub write_blocked: bool,
    pub blocked_reason: Option<String>,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Deserialize)]
pub struct GitDiffQuery {
    path: String,
    area: GitDiffArea,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitDiffArea {
    Staged,
    Unstaged,
}

#[derive(Debug, Serialize)]
pub struct GitDiffResponse {
    pub path: String,
    pub area: GitDiffArea,
    pub content: String,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GitActionRequest {
    Stage { paths: Vec<String> },
    Unstage { paths: Vec<String> },
    Commit { message: String, confirmed: bool },
    Fetch,
    Pull,
    Push { confirmed: bool },
    SwitchBranch { branch: String },
    CreateBranch { branch: String },
}

pub async fn get_git_status(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
) -> Result<Json<GitStatusResponse>, AppError> {
    ensure_current_project(&state, &project_id).await?;
    Ok(Json(read_status(&state, &project_id).await?))
}

pub async fn get_git_diff(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
    Query(query): Query<GitDiffQuery>,
) -> Result<Json<GitDiffResponse>, AppError> {
    ensure_current_project(&state, &project_id).await?;
    validate_repo_path(&query.path)?;
    let status = read_status(&state, &project_id).await?;
    let file = status
        .files
        .iter()
        .find(|file| file.path == query.path)
        .ok_or_else(|| AppError::not_found("文件不在当前 Git 变更中"))?;

    let bytes =
        if query.area == GitDiffArea::Unstaged && file.unstaged == Some(GitChangeKind::Untracked) {
            read_untracked_file(&state.project_root, &query.path).await?
        } else {
            let mut args = vec![OsString::from("diff")];
            if query.area == GitDiffArea::Staged {
                args.push(OsString::from("--cached"));
            }
            args.extend([
                OsString::from("--no-ext-diff"),
                OsString::from("--"),
                OsString::from(&query.path),
            ]);
            run_git_bytes_limited(&state.project_root, args).await?
        };
    let binary = std::str::from_utf8(&bytes).is_err() || bytes.contains(&0);
    let truncated = bytes.len() > MAX_DIFF_BYTES;
    let content = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_DIFF_BYTES)]).into_owned()
    };

    Ok(Json(GitDiffResponse {
        path: query.path,
        area: query.area,
        content,
        binary,
        truncated,
    }))
}

pub async fn execute_git_action(
    State(state): State<AppState>,
    AxumPath(project_id): AxumPath<String>,
    Json(action): Json<GitActionRequest>,
) -> Result<Json<GitStatusResponse>, AppError> {
    ensure_current_project(&state, &project_id).await?;
    let lock = scheduler_lock(&state, &project_id);
    let _guard = lock
        .try_lock()
        .map_err(|_| AppError::conflict("任务调度正在使用仓库，Git 写操作已禁用"))?;
    ensure_writes_allowed(&state, &project_id).await?;

    match action {
        GitActionRequest::Stage { paths } => {
            let paths = validate_paths(paths)?;
            let mut args = vec![OsString::from("add"), OsString::from("--")];
            args.extend(paths.into_iter().map(OsString::from));
            run_git(&state.project_root, args, "暂存失败").await?;
        }
        GitActionRequest::Unstage { paths } => {
            let paths = validate_paths(paths)?;
            let has_head =
                git_success(&state.project_root, ["rev-parse", "--verify", "HEAD"]).await;
            let mut args = if has_head {
                vec![
                    OsString::from("restore"),
                    OsString::from("--staged"),
                    OsString::from("--"),
                ]
            } else {
                vec![
                    OsString::from("rm"),
                    OsString::from("--cached"),
                    OsString::from("--"),
                ]
            };
            args.extend(paths.into_iter().map(OsString::from));
            run_git(&state.project_root, args, "取消暂存失败").await?;
        }
        GitActionRequest::Commit { message, confirmed } => {
            if !confirmed {
                return Err(AppError::bad_request("提交前必须明确确认"));
            }
            let message = message.trim();
            if message.is_empty() {
                return Err(AppError::bad_request("提交信息不能为空"));
            }
            let status = read_status(&state, &project_id).await?;
            if !status.files.iter().any(|file| file.staged.is_some()) {
                return Err(AppError::conflict("没有已暂存的变更"));
            }
            run_git(
                &state.project_root,
                ["commit", "-m", message],
                "提交失败，请检查 Git 用户配置或提交钩子",
            )
            .await?;
        }
        GitActionRequest::Fetch => {
            ensure_remote(&state.project_root).await?;
            run_git(&state.project_root, ["fetch", "origin"], "获取远端更新失败").await?;
        }
        GitActionRequest::Pull => {
            ensure_clean(&state, &project_id).await?;
            run_git(
                &state.project_root,
                ["pull", "--ff-only"],
                "拉取失败，请检查 upstream、网络或认证配置",
            )
            .await?;
        }
        GitActionRequest::Push { confirmed } => {
            if !confirmed {
                return Err(AppError::bad_request("推送前必须明确确认"));
            }
            ensure_remote(&state.project_root).await?;
            let status = read_status(&state, &project_id).await?;
            if status.upstream.is_some() {
                run_git(
                    &state.project_root,
                    ["push"],
                    "推送失败，请检查远端权限或分支规则",
                )
                .await?;
            } else {
                run_git(
                    &state.project_root,
                    ["push", "-u", "origin", "HEAD"],
                    "首次推送失败，请检查远端权限或分支规则",
                )
                .await?;
            }
        }
        GitActionRequest::SwitchBranch { branch } => {
            ensure_clean(&state, &project_id).await?;
            let branch = validate_branch(branch)?;
            let status = read_status(&state, &project_id).await?;
            if !status.branches.iter().any(|candidate| candidate == &branch) {
                return Err(AppError::bad_request("本地分支不存在"));
            }
            run_git(
                &state.project_root,
                ["switch", branch.as_str()],
                "切换分支失败",
            )
            .await?;
        }
        GitActionRequest::CreateBranch { branch } => {
            ensure_clean(&state, &project_id).await?;
            let branch = validate_branch(branch)?;
            run_git(
                &state.project_root,
                ["switch", "-c", branch.as_str()],
                "创建分支失败",
            )
            .await?;
        }
    }
    Ok(Json(read_status(&state, &project_id).await?))
}

async fn read_status(state: &AppState, project_id: &str) -> Result<GitStatusResponse, AppError> {
    let output = run_git_bytes(
        &state.project_root,
        ["status", "--porcelain=v2", "-z", "--branch"],
    )
    .await?;
    let mut status = parse_status(&output)?;
    status.branches = git_lines(
        &state.project_root,
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .await?;
    status.remote_configured = git_success(
        &state.project_root,
        ["config", "--get", "remote.origin.url"],
    )
    .await;
    status.write_blocked = writes_blocked(state, project_id).await?;
    status.blocked_reason = status
        .write_blocked
        .then(|| "存在待执行、执行中或失败待恢复的需求，Git 写操作已禁用".to_owned());
    Ok(status)
}

fn parse_status(output: &[u8]) -> Result<GitStatusResponse, AppError> {
    let records = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut metadata = HashMap::new();
    let mut index = 0;
    while index < records.len() {
        let record = std::str::from_utf8(records[index])
            .map_err(|_| AppError::conflict("Git 路径必须是 UTF-8"))?;
        index += 1;
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("# ") {
            if let Some((key, value)) = header.split_once(' ') {
                metadata.insert(key.to_owned(), value.to_owned());
            }
            continue;
        }
        let kind = record.as_bytes()[0];
        match kind {
            b'1' | b'u' => {
                let parts = record
                    .splitn(if kind == b'1' { 9 } else { 11 }, ' ')
                    .collect::<Vec<_>>();
                let xy = parts.get(1).copied().unwrap_or("..");
                let path = parts.last().copied().unwrap_or_default();
                files.push(file_status(path, None, xy, kind == b'u'));
            }
            b'2' => {
                let parts = record.splitn(10, ' ').collect::<Vec<_>>();
                let xy = parts.get(1).copied().unwrap_or("..");
                let path = parts.last().copied().unwrap_or_default();
                let original = records
                    .get(index)
                    .map(|value| {
                        std::str::from_utf8(value)
                            .map(str::to_owned)
                            .map_err(|_| AppError::conflict("Git 路径必须是 UTF-8"))
                    })
                    .transpose()?;
                index += usize::from(original.is_some());
                files.push(file_status(path, original, xy, false));
            }
            b'?' => files.push(GitFileStatus {
                path: record.get(2..).unwrap_or_default().to_owned(),
                original_path: None,
                staged: None,
                unstaged: Some(GitChangeKind::Untracked),
            }),
            _ => {}
        }
    }
    let (ahead, behind) = metadata
        .get("branch.ab")
        .and_then(|value| value.split_once(' '))
        .map(|(ahead, behind)| {
            (
                ahead.trim_start_matches('+').parse().unwrap_or(0),
                behind.trim_start_matches('-').parse().unwrap_or(0),
            )
        })
        .unwrap_or((0, 0));
    Ok(GitStatusResponse {
        branch: metadata
            .get("branch.head")
            .filter(|value| value.as_str() != "(detached)")
            .cloned(),
        head: metadata
            .get("branch.oid")
            .filter(|value| value.as_str() != "(initial)")
            .cloned(),
        upstream: metadata.get("branch.upstream").cloned(),
        ahead,
        behind,
        branches: Vec::new(),
        remote_configured: false,
        write_blocked: false,
        blocked_reason: None,
        files,
    })
}

fn file_status(
    path: &str,
    original_path: Option<String>,
    xy: &str,
    conflicted: bool,
) -> GitFileStatus {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let worktree = chars.next().unwrap_or('.');
    GitFileStatus {
        path: path.to_owned(),
        original_path,
        staged: change_kind(index, conflicted),
        unstaged: change_kind(worktree, conflicted),
    }
}

fn change_kind(value: char, conflicted: bool) -> Option<GitChangeKind> {
    if conflicted && value != '.' {
        return Some(GitChangeKind::Conflicted);
    }
    match value {
        'A' => Some(GitChangeKind::Added),
        'M' => Some(GitChangeKind::Modified),
        'D' => Some(GitChangeKind::Deleted),
        'R' => Some(GitChangeKind::Renamed),
        'C' => Some(GitChangeKind::Copied),
        'T' => Some(GitChangeKind::TypeChanged),
        'U' => Some(GitChangeKind::Conflicted),
        _ => None,
    }
}

async fn ensure_current_project(state: &AppState, project_id: &str) -> Result<(), AppError> {
    if project_id != CURRENT_PROJECT_ID {
        return Err(AppError::not_found("项目不存在"));
    }
    state.store.read().await.project_canvas(project_id)?;
    Ok(())
}

fn scheduler_lock(state: &AppState, project_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = state
        .project_scheduler_locks
        .lock()
        .expect("project scheduler lock poisoned");
    locks
        .entry(project_id.to_owned())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

async fn writes_blocked(state: &AppState, project_id: &str) -> Result<bool, AppError> {
    Ok(!state
        .store
        .read()
        .await
        .project_canvas(project_id)?
        .queued_requirements
        .is_empty())
}

async fn ensure_writes_allowed(state: &AppState, project_id: &str) -> Result<(), AppError> {
    if writes_blocked(state, project_id).await? {
        return Err(AppError::conflict(
            "存在待执行、执行中或失败待恢复的需求，Git 写操作已禁用",
        ));
    }
    Ok(())
}

async fn ensure_clean(state: &AppState, project_id: &str) -> Result<(), AppError> {
    if !read_status(state, project_id).await?.files.is_empty() {
        return Err(AppError::conflict("工作区存在未提交变更，无法执行此操作"));
    }
    Ok(())
}

async fn ensure_remote(root: &Path) -> Result<(), AppError> {
    if !git_success(root, ["config", "--get", "remote.origin.url"]).await {
        return Err(AppError::conflict("当前仓库未配置 origin"));
    }
    Ok(())
}

fn validate_paths(paths: Vec<String>) -> Result<Vec<String>, AppError> {
    if paths.is_empty() {
        return Err(AppError::bad_request("至少选择一个文件"));
    }
    paths.iter().try_for_each(|path| validate_repo_path(path))?;
    Ok(paths)
}

fn validate_repo_path(path: &str) -> Result<(), AppError> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::bad_request("文件路径必须是仓库内的相对路径"));
    }
    Ok(())
}

fn validate_branch(branch: String) -> Result<String, AppError> {
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') {
        return Err(AppError::bad_request("分支名无效"));
    }
    Ok(branch.to_owned())
}

async fn git_lines<I, S>(root: &Path, args: I) -> Result<Vec<String>, AppError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_bytes(root, args).await?;
    Ok(String::from_utf8_lossy(&output)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

async fn git_success<I, S>(root: &Path, args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .output()
        .await
        .is_ok_and(|output| output.status.success())
}

async fn run_git<I, S>(root: &Path, args: I, safe_error: &str) -> Result<(), AppError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .output()
        .await
        .map_err(AppError::from)
        .and_then(|output| {
            output
                .status
                .success()
                .then_some(())
                .ok_or_else(|| AppError::conflict(safe_error))
        })
}

async fn run_git_bytes<I, S>(root: &Path, args: I) -> Result<Vec<u8>, AppError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .output()
        .await?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(AppError::conflict("读取 Git 状态失败"))
    }
}

async fn run_git_bytes_limited<I, S>(root: &Path, args: I) -> Result<Vec<u8>, AppError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut child = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let mut bytes = Vec::new();
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::internal("无法读取 Git 输出"))?;
    (&mut stdout)
        .take((MAX_DIFF_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await?;
    if child.wait().await?.success() {
        Ok(bytes)
    } else {
        Err(AppError::conflict("读取文件差异失败"))
    }
}

async fn read_untracked_file(root: &Path, path: &str) -> Result<Vec<u8>, AppError> {
    let full_path = root.join(path);
    let metadata = tokio::fs::symlink_metadata(&full_path).await?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(AppError::bad_request("仅支持预览仓库内的普通文件"));
    }
    let canonical = normalize_local_path(&tokio::fs::canonicalize(&full_path).await?)?;
    let canonical_root = normalize_local_path(&tokio::fs::canonicalize(root).await?)?;
    if !canonical.starts_with(canonical_root) {
        return Err(AppError::bad_request("文件路径必须位于仓库内"));
    }
    let mut bytes = Vec::new();
    tokio::fs::File::open(canonical)
        .await?
        .take((MAX_DIFF_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2_paths_and_states() {
        let input = b"# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 MM N... 100644 100644 100644 abc def src/a file.rs\0\
2 R. N... 100644 100644 100644 abc def R100 src/\xe4\xb8\xad\xe6\x96\x87.rs\0old.rs\0\
? new file.txt\0\
u UU N... 100644 100644 100644 100644 a b c conflict.rs\0";
        let status = parse_status(input).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert_eq!(status.files[0].path, "src/a file.rs");
        assert_eq!(status.files[0].staged, Some(GitChangeKind::Modified));
        assert_eq!(status.files[0].unstaged, Some(GitChangeKind::Modified));
        assert_eq!(status.files[1].original_path.as_deref(), Some("old.rs"));
        assert_eq!(status.files[2].unstaged, Some(GitChangeKind::Untracked));
        assert_eq!(status.files[3].staged, Some(GitChangeKind::Conflicted));
    }

    #[test]
    fn rejects_paths_outside_repository() {
        for path in ["", "../secret", "/tmp/file", "src/../secret"] {
            assert!(validate_repo_path(path).is_err(), "{path}");
        }
        assert!(validate_repo_path("src/正常 文件.rs").is_ok());
    }
}
