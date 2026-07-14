use std::{path::Path, time::Duration};

use crate::{
    config::CommitMode,
    models::{GitProvider, PublicationReadiness},
};
use serde_json::Value;
use tokio::process::Command;

const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

pub async fn check(
    project_root: &Path,
    origin: &str,
    commit_mode: CommitMode,
) -> PublicationReadiness {
    if commit_mode == CommitMode::Local {
        return PublicationReadiness::local();
    }

    let origin = origin.trim();
    if origin.is_empty() {
        return PublicationReadiness {
            mode: "pull_request".to_owned(),
            provider: GitProvider::Local,
            ready: false,
            summary: "PR/MR 发布前置检查未通过，任务执行已阻止。".to_owned(),
            issues: vec!["pull_request 模式要求配置可访问的 origin。".to_owned()],
            notes: Vec::new(),
        };
    }

    match GitProvider::from_origin(origin) {
        GitProvider::GitHub => check_github(project_root, origin).await,
        GitProvider::GitLab => check_gitlab(project_root, origin).await,
        GitProvider::Local => PublicationReadiness::local(),
    }
}

async fn check_github(project_root: &Path, origin: &str) -> PublicationReadiness {
    let gh_available = run(project_root, "gh", &["--version"]).await.is_some();
    let Some(host) = origin_host(origin) else {
        return github_readiness(origin, gh_available, false, false, None);
    };
    let auth_args = ["auth", "status", "--active", "--hostname", &host];
    let repo_args = [
        "repo",
        "view",
        "--json",
        "nameWithOwner,viewerPermission,mergeCommitAllowed,isArchived,defaultBranchRef",
    ];
    let (git_default_branch, gh_auth, repository) = tokio::join!(
        run(
            project_root,
            "git",
            &["ls-remote", "--symref", "origin", "HEAD"]
        ),
        async {
            if gh_available {
                run(project_root, "gh", &auth_args).await
            } else {
                None
            }
        },
        async {
            if gh_available {
                run(project_root, "gh", &repo_args).await
            } else {
                None
            }
        }
    );
    let default_branch_ok = git_default_branch
        .as_deref()
        .is_some_and(|output| output.lines().any(|line| line.contains("refs/heads/")));
    let repository = repository
        .as_deref()
        .and_then(|output| serde_json::from_str::<Value>(output).ok());

    github_readiness(
        origin,
        gh_available,
        default_branch_ok,
        gh_auth.is_some(),
        repository.as_ref(),
    )
}

async fn check_gitlab(project_root: &Path, origin: &str) -> PublicationReadiness {
    let token = std::env::var("RACCOON_GITLAB_TOKEN")
        .or_else(|_| std::env::var("GITLAB_TOKEN"))
        .ok();
    let Some(host) = origin_host(origin) else {
        return gitlab_readiness(origin, token.is_some(), false, false, None);
    };
    let project_path = origin_project_path(origin);
    let (git_default_branch, repository) = tokio::join!(
        run(
            project_root,
            "git",
            &["ls-remote", "--symref", "origin", "HEAD"]
        ),
        async {
            let (Some(token), Some(project_path)) = (token.as_deref(), project_path.as_deref())
            else {
                return None;
            };
            let scheme = if origin.starts_with("http://") {
                "http"
            } else {
                "https"
            };
            let url = format!(
                "{scheme}://{host}/api/v4/projects/{}",
                percent_encode(project_path)
            );
            reqwest::Client::builder()
                .timeout(CHECK_TIMEOUT)
                .build()
                .ok()?
                .get(url)
                .header("PRIVATE-TOKEN", token)
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?
                .json::<Value>()
                .await
                .ok()
        }
    );
    let default_branch_ok = git_default_branch
        .as_deref()
        .is_some_and(|output| output.lines().any(|line| line.contains("refs/heads/")));

    gitlab_readiness(
        origin,
        token.is_some(),
        default_branch_ok,
        repository.is_some(),
        repository.as_ref(),
    )
}

async fn run(project_root: &Path, program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(project_root)
        .kill_on_drop(true);
    let output = tokio::time::timeout(CHECK_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
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

fn github_readiness(
    origin: &str,
    gh_available: bool,
    default_branch_ok: bool,
    gh_authenticated: bool,
    repository: Option<&Value>,
) -> PublicationReadiness {
    let mut issues = Vec::new();
    if !gh_available {
        issues.push(
            "未安装 GitHub CLI。请从 https://cli.github.com/ 安装 gh 后重新启动。".to_owned(),
        );
    } else if !gh_authenticated {
        issues.push("GitHub CLI 未登录 origin 对应主机。请执行 gh auth login。".to_owned());
    }
    if !default_branch_ok {
        issues.push("Git 无法读取 origin 默认分支。请检查网络、SSH key 或 Git 凭据。".to_owned());
    }

    match repository {
        None if gh_available && gh_authenticated => issues
            .push("GitHub CLI 无法识别或访问当前 origin。请检查远程地址和仓库权限。".to_owned()),
        Some(repository) => {
            if repository
                .get("isArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                issues.push("远程仓库已归档，无法推送或合并 PR。".to_owned());
            }
            if repository
                .get("defaultBranchRef")
                .is_none_or(Value::is_null)
            {
                issues.push("远程仓库没有默认分支。请先初始化远程仓库。".to_owned());
            }
            if !repository
                .get("mergeCommitAllowed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                issues.push("远程仓库未启用 Merge commit，当前自动合并方式不可用。".to_owned());
            }
            if !matches!(
                repository.get("viewerPermission").and_then(Value::as_str),
                Some("WRITE" | "MAINTAIN" | "ADMIN")
            ) {
                issues.push("当前 GitHub 账号没有仓库写入权限。".to_owned());
            }
        }
        None => {}
    }

    PublicationReadiness {
        mode: "pull_request".to_owned(),
        provider: GitProvider::GitHub,
        ready: issues.is_empty(),
        summary: if issues.is_empty() {
            "PR 发布前置检查通过。".to_owned()
        } else {
            "PR 发布前置检查未通过，任务执行已阻止。".to_owned()
        },
        issues,
        notes: vec![
            format!("origin：{}", origin.trim()),
            "实际账号仍需满足仓库分支规则，并具有推送、创建 PR 和合并权限。".to_owned(),
        ],
    }
}

fn gitlab_readiness(
    origin: &str,
    token_available: bool,
    default_branch_ok: bool,
    api_accessible: bool,
    repository: Option<&Value>,
) -> PublicationReadiness {
    let mut issues = Vec::new();
    if !token_available {
        issues.push("未设置 RACCOON_GITLAB_TOKEN 或 GITLAB_TOKEN，无法发布 GitLab MR。".to_owned());
    } else if !api_accessible {
        issues.push(
            "GitLab API 无法识别或访问当前 origin。请检查 token、主机和仓库权限。".to_owned(),
        );
    }
    if !default_branch_ok {
        issues.push("Git 无法读取 origin 默认分支。请检查网络、SSH key 或 Git 凭据。".to_owned());
    }

    match repository {
        None if token_available && api_accessible => {
            issues.push("GitLab API 返回了无效仓库信息。".to_owned())
        }
        Some(repository) => {
            if repository
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                issues.push("远程仓库已归档，无法推送或合并 MR。".to_owned());
            }
            if repository
                .get("default_branch")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                issues.push("远程仓库没有默认分支。请先初始化远程仓库。".to_owned());
            }
            if !repository
                .get("merge_requests_enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                issues.push("远程仓库未启用 Merge Request，当前自动合并方式不可用。".to_owned());
            }
            if !gitlab_write_permission(repository) {
                issues.push("当前 GitLab 账号没有仓库写入权限。".to_owned());
            }
        }
        None => {}
    }

    PublicationReadiness {
        mode: "pull_request".to_owned(),
        provider: GitProvider::GitLab,
        ready: issues.is_empty(),
        summary: if issues.is_empty() {
            "MR 发布前置检查通过。".to_owned()
        } else {
            "MR 发布前置检查未通过，任务执行已阻止。".to_owned()
        },
        issues,
        notes: vec![
            format!("origin：{}", origin.trim()),
            "实际账号仍需满足仓库分支规则，并具有推送、创建 MR 和合并权限。".to_owned(),
        ],
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

fn gitlab_write_permission(repository: &Value) -> bool {
    // Maintainer (40) or Owner (50) is required to merge MRs in most projects.
    const MAINTAINER: i64 = 40;
    repository
        .get("permissions")
        .and_then(|permissions| {
            permissions
                .get("project_access")
                .or_else(|| permissions.get("group_access"))
        })
        .and_then(|access| access.get("access_level"))
        .and_then(Value::as_i64)
        .is_some_and(|level| level >= MAINTAINER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn github_repository() -> Value {
        json!({
            "nameWithOwner": "acme/repo",
            "viewerPermission": "WRITE",
            "mergeCommitAllowed": true,
            "isArchived": false,
            "defaultBranchRef": {"name": "main"}
        })
    }

    fn gitlab_repository() -> Value {
        json!({
            "archived": false,
            "default_branch": "main",
            "merge_requests_enabled": true,
            "permissions": {
                "project_access": {"access_level": 40}
            }
        })
    }

    #[tokio::test]
    async fn local_mode_needs_no_remote_tools() {
        let readiness = check(Path::new("."), "", CommitMode::Local).await;
        assert_eq!(readiness.mode, "local");
        assert_eq!(readiness.provider, GitProvider::Local);
        assert!(readiness.ready);
    }

    #[tokio::test]
    async fn empty_origin_with_pr_mode_is_not_silently_downgraded() {
        let readiness = check(Path::new("."), "", CommitMode::PullRequest).await;
        assert_eq!(readiness.mode, "pull_request");
        assert!(!readiness.ready);
    }

    #[test]
    fn github_remote_checks_report_each_blocking_condition() {
        let missing_gh = github_readiness("git@github.com:acme/repo.git", false, true, false, None);
        assert!(
            missing_gh
                .issues
                .iter()
                .any(|issue| issue.contains("GitHub CLI"))
        );

        let unauthenticated =
            github_readiness("git@github.com:acme/repo.git", true, true, false, None);
        assert!(
            unauthenticated
                .issues
                .iter()
                .any(|issue| issue.contains("gh auth login"))
        );

        let inaccessible =
            github_readiness("git@github.com:acme/repo.git", true, false, true, None);
        assert!(
            inaccessible
                .issues
                .iter()
                .any(|issue| issue.contains("默认分支"))
        );

        for (field, value, expected) in [
            ("viewerPermission", json!("READ"), "写入权限"),
            ("mergeCommitAllowed", json!(false), "Merge commit"),
            ("isArchived", json!(true), "已归档"),
            ("defaultBranchRef", Value::Null, "默认分支"),
        ] {
            let mut metadata = github_repository();
            metadata[field] = value;
            let readiness = github_readiness(
                "git@github.com:acme/repo.git",
                true,
                true,
                true,
                Some(&metadata),
            );
            assert!(
                readiness
                    .issues
                    .iter()
                    .any(|issue| issue.contains(expected))
            );
        }
    }

    #[test]
    fn writable_github_remote_with_merge_commits_is_ready() {
        let metadata = github_repository();
        let readiness = github_readiness(
            "git@github.com:acme/repo.git",
            true,
            true,
            true,
            Some(&metadata),
        );
        assert!(readiness.ready);
        assert!(readiness.issues.is_empty());
        assert_eq!(readiness.provider, GitProvider::GitHub);
    }

    #[test]
    fn gitlab_remote_checks_report_each_blocking_condition() {
        let missing_token =
            gitlab_readiness("git@gitlab.com:acme/repo.git", false, true, false, None);
        assert!(
            missing_token
                .issues
                .iter()
                .any(|issue| issue.contains("GITLAB_TOKEN"))
        );

        let inaccessible_api =
            gitlab_readiness("git@gitlab.com:acme/repo.git", true, true, false, None);
        assert!(
            inaccessible_api
                .issues
                .iter()
                .any(|issue| issue.contains("GitLab API"))
        );

        let inaccessible =
            gitlab_readiness("git@gitlab.com:acme/repo.git", true, false, true, None);
        assert!(
            inaccessible
                .issues
                .iter()
                .any(|issue| issue.contains("默认分支"))
        );

        for (field, value, expected) in [
            ("archived", json!(true), "已归档"),
            ("default_branch", json!(""), "默认分支"),
            ("merge_requests_enabled", json!(false), "Merge Request"),
            (
                "permissions",
                json!({"project_access": {"access_level": 30}}),
                "写入权限",
            ),
        ] {
            let mut metadata = gitlab_repository();
            metadata[field] = value;
            let readiness = gitlab_readiness(
                "git@gitlab.com:acme/repo.git",
                true,
                true,
                true,
                Some(&metadata),
            );
            assert!(
                readiness
                    .issues
                    .iter()
                    .any(|issue| issue.contains(expected))
            );
        }
    }

    #[test]
    fn writable_gitlab_remote_with_merge_requests_is_ready() {
        let metadata = gitlab_repository();
        let readiness = gitlab_readiness(
            "git@gitlab.com:acme/repo.git",
            true,
            true,
            true,
            Some(&metadata),
        );
        assert!(readiness.ready);
        assert!(readiness.issues.is_empty());
        assert_eq!(readiness.provider, GitProvider::GitLab);
    }

    #[test]
    fn origin_host_parses_common_formats() {
        assert_eq!(
            origin_host("git@github.com:acme/repo.git"),
            Some("github.com".to_owned())
        );
        assert_eq!(
            origin_host("https://github.com/acme/repo.git"),
            Some("github.com".to_owned())
        );
        assert_eq!(
            origin_host("https://user@gitlab.com/acme/repo.git"),
            Some("gitlab.com".to_owned())
        );
        assert_eq!(origin_host(""), None);
    }
}
