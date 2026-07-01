use std::{path::Path, time::Duration};

use raccoon_core::models::PublicationReadiness;
use serde_json::Value;
use tokio::process::Command;

const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

pub async fn check(project_root: &Path, origin: &str) -> PublicationReadiness {
    if origin.trim().is_empty() {
        return PublicationReadiness::local();
    }

    let gh_available = run(project_root, "gh", &["--version"]).await.is_some();
    let Some(host) = origin_host(origin) else {
        return remote_readiness(origin, gh_available, false, false, None);
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

    remote_readiness(
        origin,
        gh_available,
        default_branch_ok,
        gh_auth.is_some(),
        repository.as_ref(),
    )
}

async fn run(project_root: &Path, program: &str, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(
        CHECK_TIMEOUT,
        Command::new(program)
            .args(args)
            .current_dir(project_root)
            .output(),
    )
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

fn remote_readiness(
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn repository() -> Value {
        json!({
            "nameWithOwner": "acme/repo",
            "viewerPermission": "WRITE",
            "mergeCommitAllowed": true,
            "isArchived": false,
            "defaultBranchRef": {"name": "main"}
        })
    }

    #[tokio::test]
    async fn local_repository_needs_no_remote_tools() {
        let readiness = check(Path::new("."), "").await;
        assert_eq!(readiness.mode, "local");
        assert!(readiness.ready);
    }

    #[test]
    fn remote_checks_report_each_blocking_condition() {
        let missing_gh = remote_readiness("git@github.com:acme/repo.git", false, true, false, None);
        assert!(
            missing_gh
                .issues
                .iter()
                .any(|issue| issue.contains("GitHub CLI"))
        );

        let unauthenticated =
            remote_readiness("git@github.com:acme/repo.git", true, true, false, None);
        assert!(
            unauthenticated
                .issues
                .iter()
                .any(|issue| issue.contains("gh auth login"))
        );

        let inaccessible =
            remote_readiness("git@github.com:acme/repo.git", true, false, true, None);
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
            let mut metadata = repository();
            metadata[field] = value;
            let readiness = remote_readiness(
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
    fn writable_remote_with_merge_commits_is_ready() {
        let metadata = repository();
        let readiness = remote_readiness(
            "git@github.com:acme/repo.git",
            true,
            true,
            true,
            Some(&metadata),
        );
        assert!(readiness.ready);
        assert!(readiness.issues.is_empty());
    }
}
