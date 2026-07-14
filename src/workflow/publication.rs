use std::path::Path;
use std::process::Stdio;

use chrono::Utc;
use reqwest::{Client, Method};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::config::CommitMode;
use crate::error::AppError;

use super::{
    IntegrationWorkspace, WorkflowCleanupStatus, WorkflowLocalSyncStatus, WorkflowPublication,
    WorkflowPublicationMode, WorkflowPublicationPhase, WorkflowPublicationProvider, git_output,
};

const MAX_REMOTE_FAILURE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteReviewState {
    Waiting { summary: String },
    ChecksFailed { summary: String },
    Blocked { reason: String },
    Merged { commit: String },
}

pub async fn discover_publication(
    workspace: &IntegrationWorkspace,
    commit_mode: CommitMode,
) -> Result<WorkflowPublication, AppError> {
    let (mode, provider, origin, target_branch) = match commit_mode {
        CommitMode::Local => {
            let target = git_output(
                &workspace.project_root,
                &["rev-parse", "--abbrev-ref", "HEAD"],
            )
            .await?
            .trim()
            .to_owned();
            (
                WorkflowPublicationMode::Local,
                WorkflowPublicationProvider::Local,
                String::new(),
                target,
            )
        }
        CommitMode::PullRequest => {
            let origin = git_output(&workspace.project_root, &["remote", "get-url", "origin"])
                .await?
                .trim()
                .to_owned();
            let target = remote_default_branch(&workspace.project_root).await?;
            (
                WorkflowPublicationMode::PullRequest,
                provider_from_origin(&origin)?,
                origin,
                target,
            )
        }
    };
    Ok(WorkflowPublication {
        run_id: String::new(),
        mode,
        provider,
        phase: WorkflowPublicationPhase::Prepared,
        origin,
        target_branch,
        source_branch: workspace.branch.clone(),
        review_url: None,
        head_commit: None,
        merge_commit: None,
        local_sync_status: WorkflowLocalSyncStatus::Pending,
        local_sync_message: None,
        cleanup_status: WorkflowCleanupStatus::Pending,
        remote_ci_fix_used: false,
        last_error: None,
        updated_at: Utc::now(),
    })
}

pub async fn open_remote_review(
    workspace: &IntegrationWorkspace,
    publication: &WorkflowPublication,
    title: &str,
    body: &str,
) -> Result<String, AppError> {
    match publication.provider {
        WorkflowPublicationProvider::GitHub => {
            github_open_review(workspace, publication, title, body).await
        }
        WorkflowPublicationProvider::GitLab => gitlab_open_review(publication, title, body).await,
        WorkflowPublicationProvider::Local => {
            Err(AppError::bad_request("本地发布模式不能创建远端 review"))
        }
    }
}

pub async fn arm_remote_auto_merge(
    workspace: &IntegrationWorkspace,
    publication: &WorkflowPublication,
) -> Result<(), AppError> {
    let review_url = publication
        .review_url
        .as_deref()
        .ok_or_else(|| AppError::conflict("远端 review URL 尚未保存"))?;
    let head = publication
        .head_commit
        .as_deref()
        .ok_or_else(|| AppError::conflict("远端 review head 尚未保存"))?;
    match publication.provider {
        WorkflowPublicationProvider::GitHub => {
            gh_output(
                &workspace.project_root,
                &[
                    "pr",
                    "merge",
                    review_url,
                    "--auto",
                    "--merge",
                    "--match-head-commit",
                    head,
                ],
                None,
            )
            .await?;
            Ok(())
        }
        WorkflowPublicationProvider::GitLab => {
            let target = GitLabTarget::from_origin(&publication.origin)?;
            let iid = gitlab_review_iid(review_url)?;
            let response = gitlab_request(
                &target,
                Method::PUT,
                &format!("/merge_requests/{iid}/merge"),
                Some(json!({
                    "auto_merge": true,
                    "sha": head,
                    "should_remove_source_branch": true,
                })),
            )
            .await?;
            ensure_gitlab_success(response, "启用 GitLab MR 自动合并").await?;
            Ok(())
        }
        WorkflowPublicationProvider::Local => {
            Err(AppError::bad_request("本地发布模式没有自动合并"))
        }
    }
}

pub async fn remote_review_state(
    workspace: &IntegrationWorkspace,
    publication: &WorkflowPublication,
) -> Result<RemoteReviewState, AppError> {
    match publication.provider {
        WorkflowPublicationProvider::GitHub => github_review_state(workspace, publication).await,
        WorkflowPublicationProvider::GitLab => gitlab_review_state(publication).await,
        WorkflowPublicationProvider::Local => {
            Err(AppError::bad_request("本地发布模式没有远端 review 状态"))
        }
    }
}

async fn remote_default_branch(project_root: &Path) -> Result<String, AppError> {
    let output = git_output(project_root, &["ls-remote", "--symref", "origin", "HEAD"]).await?;
    output
        .lines()
        .find_map(|line| {
            line.strip_prefix("ref: refs/heads/")
                .and_then(|rest| rest.split_whitespace().next())
                .map(ToOwned::to_owned)
        })
        .ok_or_else(|| AppError::conflict("无法冻结 origin 默认目标分支"))
}

fn provider_from_origin(origin: &str) -> Result<WorkflowPublicationProvider, AppError> {
    let host = origin_host(origin)
        .ok_or_else(|| AppError::bad_request("origin 不是受支持的 GitHub/GitLab 地址"))?;
    if host.eq_ignore_ascii_case("github.com") || host.ends_with(".github.com") {
        Ok(WorkflowPublicationProvider::GitHub)
    } else if host.to_ascii_lowercase().contains("gitlab") {
        Ok(WorkflowPublicationProvider::GitLab)
    } else {
        Err(AppError::bad_request(format!(
            "pull_request 模式暂不支持 origin 主机 {host}"
        )))
    }
}

fn origin_host(origin: &str) -> Option<String> {
    let origin = origin.trim();
    if let Some(rest) = origin.strip_prefix("git@") {
        return rest.split_once(':').map(|(host, _)| host.to_owned());
    }
    let (_, rest) = origin.split_once("://")?;
    rest.split('/')
        .next()
        .and_then(|authority| authority.rsplit('@').next())
        .filter(|host| !host.is_empty())
        .map(ToOwned::to_owned)
}

async fn github_open_review(
    workspace: &IntegrationWorkspace,
    publication: &WorkflowPublication,
    title: &str,
    body: &str,
) -> Result<String, AppError> {
    let existing = gh_output(
        &workspace.project_root,
        &[
            "pr",
            "list",
            "--head",
            &publication.source_branch,
            "--state",
            "all",
            "--json",
            "url,state,headRefOid,mergeCommit",
        ],
        None,
    )
    .await?;
    let reviews: Vec<Value> = serde_json::from_str(&existing)?;
    if let Some(review) = reviews.first() {
        let state = review.get("state").and_then(Value::as_str).unwrap_or("");
        if state == "CLOSED" {
            return Err(AppError::conflict(
                "同一 workflow 分支的 GitHub PR 已关闭但未合并",
            ));
        }
        if let Some(expected) = publication.head_commit.as_deref()
            && review.get("headRefOid").and_then(Value::as_str) != Some(expected)
        {
            return Err(AppError::conflict(
                "既有 GitHub PR 的 head SHA 与冻结发布记录不一致",
            ));
        }
        return review
            .get("url")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| AppError::internal("GitHub PR 缺少 URL"));
    }
    gh_output(
        &workspace.project_root,
        &[
            "pr",
            "create",
            "--base",
            &publication.target_branch,
            "--head",
            &publication.source_branch,
            "--title",
            title,
            "--body-file",
            "-",
        ],
        Some(body),
    )
    .await
    .map(|value| value.trim().to_owned())
}

async fn github_review_state(
    workspace: &IntegrationWorkspace,
    publication: &WorkflowPublication,
) -> Result<RemoteReviewState, AppError> {
    let url = publication
        .review_url
        .as_deref()
        .ok_or_else(|| AppError::conflict("GitHub PR URL 尚未保存"))?;
    let output = gh_output(
        &workspace.project_root,
        &[
            "pr",
            "view",
            url,
            "--json",
            "state,mergeCommit,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup",
        ],
        None,
    )
    .await?;
    let review: Value = serde_json::from_str(&output)?;
    parse_github_review_state(&review)
}

fn parse_github_review_state(review: &Value) -> Result<RemoteReviewState, AppError> {
    if review.get("state").and_then(Value::as_str) == Some("MERGED") {
        let commit = review
            .pointer("/mergeCommit/oid")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::internal("GitHub 已合并 PR 缺少 merge commit"))?;
        return Ok(RemoteReviewState::Merged {
            commit: commit.to_owned(),
        });
    }
    if review.get("state").and_then(Value::as_str) == Some("CLOSED") {
        return Ok(RemoteReviewState::Blocked {
            reason: "GitHub PR 已关闭但未合并".to_owned(),
        });
    }
    let checks = review
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let failed = checks
        .iter()
        .filter(|check| {
            check
                .get("conclusion")
                .and_then(Value::as_str)
                .is_some_and(|value| !matches!(value, "SUCCESS" | "SKIPPED" | "NEUTRAL" | ""))
        })
        .map(check_summary)
        .collect::<Vec<_>>();
    if !failed.is_empty() {
        return Ok(RemoteReviewState::ChecksFailed {
            summary: bounded_remote_summary(failed.join("\n")),
        });
    }
    if matches!(
        review.get("reviewDecision").and_then(Value::as_str),
        Some("CHANGES_REQUESTED" | "REVIEW_REQUIRED")
    ) {
        return Ok(RemoteReviewState::Blocked {
            reason: "GitHub PR 正在等待外部审核或修改".to_owned(),
        });
    }
    if matches!(
        review.get("mergeStateStatus").and_then(Value::as_str),
        Some("DIRTY" | "BEHIND")
    ) {
        return Ok(RemoteReviewState::Blocked {
            reason: format!(
                "GitHub PR 需要外部处理：mergeStateStatus={}",
                review
                    .get("mergeStateStatus")
                    .and_then(Value::as_str)
                    .unwrap_or("UNKNOWN")
            ),
        });
    }
    Ok(RemoteReviewState::Waiting {
        summary: format!(
            "GitHub checks 进行中；mergeStateStatus={}",
            review
                .get("mergeStateStatus")
                .and_then(Value::as_str)
                .unwrap_or("UNKNOWN")
        ),
    })
}

fn check_summary(check: &Value) -> String {
    let name = check
        .get("name")
        .or_else(|| check.get("context"))
        .and_then(Value::as_str)
        .unwrap_or("unknown check");
    let conclusion = check
        .get("conclusion")
        .or_else(|| check.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format!("{name}: {conclusion}")
}

async fn gh_output(
    working_dir: &Path,
    args: &[&str],
    stdin: Option<&str>,
) -> Result<String, AppError> {
    let mut command = Command::new("gh");
    command
        .args(args)
        .current_dir(working_dir)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .ok_or_else(|| AppError::internal("无法写入 gh stdin"))?
            .write_all(input.as_bytes())
            .await?;
    }
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        return Err(AppError::internal(format!(
            "gh {} 失败：{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Debug, Clone)]
struct GitLabTarget {
    api_base: String,
}

impl GitLabTarget {
    fn from_origin(origin: &str) -> Result<Self, AppError> {
        let host = origin_host(origin)
            .ok_or_else(|| AppError::bad_request("无法解析 GitLab origin 主机"))?;
        let project = origin_project_path(origin)
            .ok_or_else(|| AppError::bad_request("无法解析 GitLab project path"))?;
        let scheme = if origin.starts_with("http://") {
            "http"
        } else {
            "https"
        };
        Ok(Self {
            api_base: format!(
                "{scheme}://{host}/api/v4/projects/{}",
                percent_encode(&project)
            ),
        })
    }
}

fn origin_project_path(origin: &str) -> Option<String> {
    let path = if let Some(rest) = origin.strip_prefix("git@") {
        rest.split_once(':')?.1
    } else {
        let (_, rest) = origin.split_once("://")?;
        rest.split_once('/')?.1
    };
    Some(
        path.trim_end_matches('/')
            .trim_end_matches(".git")
            .to_owned(),
    )
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

async fn gitlab_open_review(
    publication: &WorkflowPublication,
    title: &str,
    body: &str,
) -> Result<String, AppError> {
    let target = GitLabTarget::from_origin(&publication.origin)?;
    let response = gitlab_request(
        &target,
        Method::GET,
        &format!(
            "/merge_requests?scope=all&state=all&source_branch={}",
            percent_encode(&publication.source_branch)
        ),
        None,
    )
    .await?;
    let existing = ensure_gitlab_success(response, "查找 GitLab MR")
        .await?
        .json::<Vec<Value>>()
        .await
        .map_err(|error| AppError::internal(format!("解析 GitLab MR 列表失败：{error}")))?;
    if let Some(review) = existing.first() {
        if review.get("state").and_then(Value::as_str) == Some("closed") {
            return Err(AppError::conflict(
                "同一 workflow 分支的 GitLab MR 已关闭但未合并",
            ));
        }
        if let Some(expected) = publication.head_commit.as_deref()
            && review.get("sha").and_then(Value::as_str) != Some(expected)
        {
            return Err(AppError::conflict(
                "既有 GitLab MR 的 head SHA 与冻结发布记录不一致",
            ));
        }
        return review
            .get("web_url")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| AppError::internal("GitLab MR 缺少 URL"));
    }
    let response = gitlab_request(
        &target,
        Method::POST,
        "/merge_requests",
        Some(json!({
            "source_branch": publication.source_branch,
            "target_branch": publication.target_branch,
            "title": title,
            "description": body,
            "remove_source_branch": true,
        })),
    )
    .await?;
    let review = ensure_gitlab_success(response, "创建 GitLab MR")
        .await?
        .json::<Value>()
        .await
        .map_err(|error| AppError::internal(format!("解析 GitLab MR 响应失败：{error}")))?;
    review
        .get("web_url")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::internal("GitLab MR 创建响应缺少 URL"))
}

async fn gitlab_review_state(
    publication: &WorkflowPublication,
) -> Result<RemoteReviewState, AppError> {
    let review_url = publication
        .review_url
        .as_deref()
        .ok_or_else(|| AppError::conflict("GitLab MR URL 尚未保存"))?;
    let iid = gitlab_review_iid(review_url)?;
    let target = GitLabTarget::from_origin(&publication.origin)?;
    let response = gitlab_request(
        &target,
        Method::GET,
        &format!("/merge_requests/{iid}"),
        None,
    )
    .await?;
    let review = ensure_gitlab_success(response, "读取 GitLab MR")
        .await?
        .json::<Value>()
        .await
        .map_err(|error| AppError::internal(format!("解析 GitLab MR 状态失败：{error}")))?;
    parse_gitlab_review_state(&review)
}

fn parse_gitlab_review_state(review: &Value) -> Result<RemoteReviewState, AppError> {
    match review.get("state").and_then(Value::as_str) {
        Some("merged") => {
            let commit = review
                .get("merge_commit_sha")
                .or_else(|| review.get("squash_commit_sha"))
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::internal("GitLab 已合并 MR 缺少 merge commit"))?;
            return Ok(RemoteReviewState::Merged {
                commit: commit.to_owned(),
            });
        }
        Some("closed") => {
            return Ok(RemoteReviewState::Blocked {
                reason: "GitLab MR 已关闭但未合并".to_owned(),
            });
        }
        _ => {}
    }
    let pipeline = review.get("head_pipeline");
    let pipeline_status = pipeline
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    if matches!(pipeline_status, Some("failed" | "canceled")) {
        return Ok(RemoteReviewState::ChecksFailed {
            summary: bounded_remote_summary(format!(
                "GitLab pipeline {}: {}",
                pipeline
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_i64)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_owned()),
                pipeline_status.unwrap_or("failed")
            )),
        });
    }
    let merge_status = review
        .get("detailed_merge_status")
        .and_then(Value::as_str)
        .unwrap_or("unchecked");
    if matches!(
        merge_status,
        "approvals_syncing"
            | "not_approved"
            | "discussions_not_resolved"
            | "requested_changes"
            | "conflict"
            | "draft_status"
            | "merge_request_blocked"
    ) {
        return Ok(RemoteReviewState::Blocked {
            reason: format!("GitLab MR 等待外部操作：{merge_status}"),
        });
    }
    Ok(RemoteReviewState::Waiting {
        summary: format!("GitLab MR 等待检查或合并队列：{merge_status}"),
    })
}

async fn gitlab_request(
    target: &GitLabTarget,
    method: Method,
    suffix: &str,
    body: Option<Value>,
) -> Result<reqwest::Response, AppError> {
    let token = std::env::var("RACCOON_GITLAB_TOKEN")
        .or_else(|_| std::env::var("GITLAB_TOKEN"))
        .map_err(|_| {
            AppError::bad_request("GitLab 发布需要 RACCOON_GITLAB_TOKEN 或 GITLAB_TOKEN 环境变量")
        })?;
    let mut request = Client::new()
        .request(method, format!("{}{}", target.api_base, suffix))
        .header("PRIVATE-TOKEN", token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    request
        .send()
        .await
        .map_err(|error| AppError::internal(format!("GitLab API 请求失败：{error}")))
}

async fn ensure_gitlab_success(
    response: reqwest::Response,
    action: &str,
) -> Result<reqwest::Response, AppError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let message = response.text().await.unwrap_or_default();
    Err(AppError::internal(format!(
        "{action}失败（{status}）：{}",
        bounded_remote_summary(message)
    )))
}

fn gitlab_review_iid(url: &str) -> Result<u64, AppError> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| AppError::internal("GitLab MR URL 缺少 IID"))
}

fn bounded_remote_summary(mut summary: String) -> String {
    if summary.len() > MAX_REMOTE_FAILURE_BYTES {
        summary.truncate(MAX_REMOTE_FAILURE_BYTES);
        summary.push_str("\n…远端失败摘要已截断");
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_and_ssh_gitlab_targets() {
        for origin in [
            "git@gitlab.example.com:group/project.git",
            "https://gitlab.example.com/group/project.git",
        ] {
            let target = GitLabTarget::from_origin(origin).unwrap();
            assert!(target.api_base.ends_with("/projects/group%2Fproject"));
        }
    }

    #[test]
    fn provider_rejects_unknown_pull_request_hosts() {
        assert!(provider_from_origin("git@example.com:group/project.git").is_err());
    }

    #[test]
    fn publication_provider_uses_stable_api_names() {
        assert_eq!(
            serde_json::to_string(&WorkflowPublicationProvider::GitHub).unwrap(),
            "\"github\""
        );
        assert_eq!(
            serde_json::to_string(&WorkflowPublicationProvider::GitLab).unwrap(),
            "\"gitlab\""
        );
    }

    #[test]
    fn github_status_distinguishes_merge_ci_failure_and_external_review() {
        assert_eq!(
            parse_github_review_state(&json!({
                "state": "MERGED",
                "mergeCommit": {"oid": "merge-sha"}
            }))
            .unwrap(),
            RemoteReviewState::Merged {
                commit: "merge-sha".to_owned()
            }
        );
        assert!(matches!(
            parse_github_review_state(&json!({
                "state": "OPEN",
                "statusCheckRollup": [{"name": "test", "conclusion": "FAILURE"}]
            }))
            .unwrap(),
            RemoteReviewState::ChecksFailed { .. }
        ));
        assert!(matches!(
            parse_github_review_state(&json!({
                "state": "OPEN",
                "statusCheckRollup": [],
                "reviewDecision": "REVIEW_REQUIRED"
            }))
            .unwrap(),
            RemoteReviewState::Blocked { .. }
        ));
    }

    #[test]
    fn gitlab_status_distinguishes_merge_pipeline_failure_and_approval() {
        assert_eq!(
            parse_gitlab_review_state(&json!({
                "state": "merged",
                "merge_commit_sha": "merge-sha"
            }))
            .unwrap(),
            RemoteReviewState::Merged {
                commit: "merge-sha".to_owned()
            }
        );
        assert!(matches!(
            parse_gitlab_review_state(&json!({
                "state": "opened",
                "head_pipeline": {"id": 7, "status": "failed"}
            }))
            .unwrap(),
            RemoteReviewState::ChecksFailed { .. }
        ));
        assert!(matches!(
            parse_gitlab_review_state(&json!({
                "state": "opened",
                "detailed_merge_status": "not_approved"
            }))
            .unwrap(),
            RemoteReviewState::Blocked { .. }
        ));
    }
}
