#[allow(unused_imports)]
use super::*;

use super::{
    attach_session_usage, build_gitlab_mr_merge_args, build_pr_merge_args,
    event_has_output_activity, generated_branch_names, is_terminal_agent_end, local_merge_base,
    merge_local_branch, parse_default_branch, parse_remote_default_branch,
    parse_session_header_cwd, repository_has_origin, resolve_project_working_dir,
    safe_worktree_name, session_header_matches_working_dir, stage_task_changes,
    sync_checked_out_remote_base,
};
use crate::models::{
    RequirementExecutionPlan, RequirementModelTier, RequirementReviewStatus,
    RequirementTaskExecutionOutput, RequirementTaskKind, RequirementTaskStatus,
};
use crate::utils::commit_staged_changes;
use std::path::Path;

#[test]
fn parse_default_branch_falls_back_to_main() {
    assert_eq!(parse_default_branch("origin/main\n"), "main");
    assert_eq!(parse_default_branch("origin/trunk\n"), "trunk");
    assert_eq!(parse_default_branch(""), "main");
}

#[test]
fn parses_remote_default_branch_without_guessing() {
    assert_eq!(
        parse_remote_default_branch(
            "ref: refs/heads/trunk\tHEAD\nabc123\tHEAD\nabc123\trefs/heads/trunk\n"
        )
        .as_deref(),
        Some("trunk")
    );
    assert_eq!(parse_remote_default_branch("abc123\tHEAD\n"), None);
}

#[test]
fn session_header_requires_absolute_cwd() {
    assert!(parse_session_header_cwd(r#"{"type":"session","cwd":"relative"}"#).is_err());
    assert!(parse_session_header_cwd(r#"{"type":"message","cwd":"/tmp"}"#).is_err());
    let cwd = std::env::current_dir().unwrap();
    let header = serde_json::json!({ "type": "session", "cwd": cwd }).to_string();
    assert_eq!(
        parse_session_header_cwd(&header).unwrap(),
        std::env::current_dir().unwrap()
    );
}

#[test]
fn restored_session_must_match_the_client_working_directory() {
    let cwd = std::env::current_dir().unwrap();
    let matching = serde_json::json!({ "type": "session", "cwd": cwd }).to_string();
    let other = serde_json::json!({ "type": "session", "cwd": cwd.join("other") }).to_string();

    assert!(session_header_matches_working_dir(&matching, &cwd));
    assert!(!session_header_matches_working_dir(&other, &cwd));
    assert!(!session_header_matches_working_dir("invalid", &cwd));
}

#[test]
fn worktree_names_avoid_windows_reserved_names_and_long_components() {
    assert_eq!(safe_worktree_name("CON"), "_con");
    assert_eq!(safe_worktree_name("com1"), "_com1");
    let long = safe_worktree_name(&"a".repeat(300));
    assert!(long.len() <= 80);
    assert_ne!(long, safe_worktree_name(&"b".repeat(300)));
}

#[test]
fn pi_working_directory_is_limited_to_project_root_or_managed_worktree() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("repo");
    std::fs::create_dir(&project).unwrap();
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&project)
            .status()
            .unwrap()
            .success()
    );
    let data_root = project.join(".raccoon-node");
    std::fs::create_dir_all(data_root.join("worktrees")).unwrap();

    assert_eq!(
        resolve_project_working_dir(&data_root, &project.to_string_lossy()).unwrap(),
        crate::utils::normalize_local_path(&std::fs::canonicalize(&project).unwrap()).unwrap()
    );
    assert!(resolve_project_working_dir(&data_root, &temp.path().to_string_lossy()).is_err());
    assert!(resolve_project_working_dir(&data_root, "relative").is_err());
}

#[test]
fn pr_merge_args_lock_head_commit_without_deleting_branch() {
    assert_eq!(
        build_pr_merge_args("https://github.com/acme/repo/pull/1", "abc123"),
        vec![
            "pr",
            "merge",
            "https://github.com/acme/repo/pull/1",
            "--merge",
            "--match-head-commit",
            "abc123",
        ]
    );
}

#[test]
fn gitlab_mr_merge_args_lock_head_commit_without_deleting_branch() {
    assert_eq!(
        build_gitlab_mr_merge_args("feature-branch", "abc123"),
        vec!["mr", "merge", "feature-branch", "--sha", "abc123", "--yes",]
    );
}

#[test]
fn generated_branch_names_only_keeps_rn_branches() {
    let branches = generated_branch_names(["rn/req/task", "main", "feature/x"].into_iter());
    assert_eq!(
        branches.into_iter().collect::<Vec<_>>(),
        vec!["rn/req/task"]
    );
}

#[tokio::test]
async fn origin_configuration_selects_remote_publication() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    assert!(!repository_has_origin(temp.path()).await);

    super::git(
        temp.path(),
        &["remote", "add", "origin", "https://example.com/repo.git"],
    )
    .await
    .unwrap();

    assert!(repository_has_origin(temp.path()).await);
}

#[tokio::test]
async fn local_merge_uses_clean_current_branch() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    let base = local_merge_base(temp.path()).await.unwrap();
    super::git(temp.path(), &["checkout", "-b", "rn/req/merge-review"])
        .await
        .unwrap();
    tokio::fs::write(temp.path().join("feature.txt"), "done\n")
        .await
        .unwrap();
    super::git(temp.path(), &["add", "feature.txt"])
        .await
        .unwrap();
    super::git(temp.path(), &["commit", "-m", "feature"])
        .await
        .unwrap();
    super::git(temp.path(), &["checkout", &base]).await.unwrap();

    merge_local_branch(temp.path(), "rn/req/merge-review")
        .await
        .unwrap();

    assert_eq!(local_merge_base(temp.path()).await.unwrap(), base);
    assert_eq!(
        tokio::fs::read_to_string(temp.path().join("feature.txt"))
            .await
            .unwrap(),
        "done\n"
    );
}

#[tokio::test]
async fn local_merge_rejects_dirty_or_detached_root() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    tokio::fs::write(temp.path().join("dirty.txt"), "dirty\n")
        .await
        .unwrap();
    assert!(
        local_merge_base(temp.path())
            .await
            .unwrap_err()
            .to_string()
            .contains("未提交改动")
    );
    tokio::fs::remove_file(temp.path().join("dirty.txt"))
        .await
        .unwrap();
    super::git(temp.path(), &["checkout", "--detach"])
        .await
        .unwrap();
    assert!(
        local_merge_base(temp.path())
            .await
            .unwrap_err()
            .to_string()
            .contains("detached HEAD")
    );
}

#[tokio::test]
async fn local_merge_aborts_conflicts_without_losing_base_changes() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    let base = local_merge_base(temp.path()).await.unwrap();
    super::git(temp.path(), &["checkout", "-b", "rn/req/merge-review"])
        .await
        .unwrap();
    tokio::fs::write(temp.path().join("README.md"), "feature\n")
        .await
        .unwrap();
    super::git(temp.path(), &["commit", "-am", "feature"])
        .await
        .unwrap();
    super::git(temp.path(), &["checkout", &base]).await.unwrap();
    tokio::fs::write(temp.path().join("README.md"), "base\n")
        .await
        .unwrap();
    super::git(temp.path(), &["commit", "-am", "base"])
        .await
        .unwrap();

    assert!(
        merge_local_branch(temp.path(), "rn/req/merge-review")
            .await
            .is_err()
    );
    assert_eq!(
        tokio::fs::read_to_string(temp.path().join("README.md"))
            .await
            .unwrap(),
        "base\n"
    );
    assert!(
        super::git(temp.path(), &["rev-parse", "--verify", "MERGE_HEAD"])
            .await
            .is_err()
    );
    assert!(
        super::git(temp.path(), &["status", "--porcelain"])
            .await
            .unwrap()
            .trim()
            .is_empty()
    );
}

#[tokio::test]
async fn remote_base_sync_only_fast_forwards_the_checked_out_branch() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let remote = temp.path().join("origin.git");
    let writer = temp.path().join("writer");
    tokio::fs::create_dir(&repo).await.unwrap();
    tokio::fs::create_dir(&remote).await.unwrap();
    init_repo(&repo).await;
    super::git(&remote, &["init", "--bare"]).await.unwrap();
    let base = local_merge_base(&repo).await.unwrap();
    super::git(
        &repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    )
    .await
    .unwrap();
    super::git(&repo, &["push", "-u", "origin", &base])
        .await
        .unwrap();
    super::git(
        temp.path(),
        &["clone", remote.to_str().unwrap(), writer.to_str().unwrap()],
    )
    .await
    .unwrap();
    super::git(&writer, &["config", "user.email", "test@example.com"])
        .await
        .unwrap();
    super::git(&writer, &["config", "user.name", "Test"])
        .await
        .unwrap();
    super::git(&writer, &["checkout", &base]).await.unwrap();
    tokio::fs::write(writer.join("remote.txt"), "remote\n")
        .await
        .unwrap();
    super::git(&writer, &["add", "remote.txt"]).await.unwrap();
    super::git(&writer, &["commit", "-m", "remote"])
        .await
        .unwrap();
    super::git(&writer, &["push", "origin", &base])
        .await
        .unwrap();

    sync_checked_out_remote_base(&repo, &base).await.unwrap();

    assert_eq!(
        super::git(&repo, &["rev-parse", "HEAD"])
            .await
            .unwrap()
            .trim(),
        super::git(&repo, &["rev-parse", &format!("origin/{base}")])
            .await
            .unwrap()
            .trim()
    );
}

#[test]
fn wait_only_finishes_on_final_agent_end() {
    assert!(!is_terminal_agent_end(
        &serde_json::json!({ "type": "turn_end" })
    ));
    assert!(!is_terminal_agent_end(&serde_json::json!({
        "type": "agent_end",
        "willRetry": true
    })));
    assert!(is_terminal_agent_end(&serde_json::json!({
        "type": "agent_end",
        "willRetry": false
    })));
    assert!(is_terminal_agent_end(
        &serde_json::json!({ "type": "agent_end" })
    ));
}

#[test]
fn event_activity_detects_output_content() {
    assert!(event_has_output_activity(&serde_json::json!({
        "type": "message_update",
        "assistantMessageEvent": {
            "type": "text_delta",
            "delta": "{\"ok\":true}"
        }
    })));
    assert!(event_has_output_activity(&serde_json::json!({
        "type": "message_update",
        "assistantMessageEvent": {
            "type": "thinking_delta",
            "delta": "思考"
        }
    })));
    assert!(event_has_output_activity(&serde_json::json!({
        "type": "tool_execution_update",
        "partialResult": {
            "content": [{"text": "running tests"}]
        }
    })));
}

#[test]
fn event_activity_ignores_response_and_empty_lifecycle_events() {
    assert!(!event_has_output_activity(&serde_json::json!({
        "type": "response",
        "success": true
    })));
    assert!(!event_has_output_activity(&serde_json::json!({
        "type": "agent_start"
    })));
    assert!(!event_has_output_activity(&serde_json::json!({
        "type": "message_update",
        "assistantMessageEvent": {
            "type": "text_delta",
            "delta": "   "
        }
    })));
}

#[test]
fn session_stats_are_normalized_into_trace_usage() {
    let trace = Some(serde_json::json!({
        "type": "pi_trace",
        "version": 1,
        "trace": {
            "thinking": "",
            "output": "",
            "tools": [],
            "statuses": []
        }
    }));
    let trace = attach_session_usage(
        trace,
        &serde_json::json!({
            "assistantMessages": 3,
            "tokens": {
                "input": 1500,
                "output": 320,
                "cacheRead": 1000,
                "cacheWrite": 240
            },
            "contextUsage": {
                "tokens": 12000,
                "contextWindow": 128000,
                "percent": 9.4
            }
        }),
        true,
    )
    .unwrap();

    assert_eq!(trace["trace"]["usage"]["sessionReused"], true);
    assert_eq!(trace["trace"]["usage"]["callCount"], 3);
    assert_eq!(trace["trace"]["usage"]["cacheRead"], 1000);
    assert_eq!(trace["trace"]["usage"]["context"]["window"], 128000);
}

#[test]
fn dependency_branches_follow_task_dependency_order() {
    let mut task_a = test_task(Path::new("/tmp/a"));
    task_a.id = "task-a".to_owned();
    task_a.branch_name = Some("branch-a".to_owned());
    let mut task_b = test_task(Path::new("/tmp/b"));
    task_b.id = "task-b".to_owned();
    task_b.branch_name = Some("branch-b".to_owned());
    let mut task_c = test_task(Path::new("/tmp/c"));
    task_c.id = "task-c".to_owned();
    task_c.depends_on = vec!["task-b".to_owned(), "task-a".to_owned()];
    let plan = RequirementExecutionPlan {
        summary: "plan".to_owned(),
        tasks: vec![task_a, task_b, task_c.clone()],
    };

    assert_eq!(
        super::dependency_branches_for_task(&task_c, &plan),
        vec!["branch-b", "branch-a"]
    );
}

#[tokio::test]
async fn implementation_no_diff_can_complete_with_no_op_reason() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    let task = test_task(temp.path());
    let mut output = test_output(Some(false), Some("前置节点已完整实现"));

    stage_task_changes(&task, &mut output).await.unwrap();

    let head = super::git(temp.path(), &["rev-parse", "HEAD"])
        .await
        .unwrap();
    let status = super::git(temp.path(), &["status", "--porcelain"])
        .await
        .unwrap();
    assert!(status.trim().is_empty());
    assert!(!head.trim().is_empty());
    assert_eq!(
        output.execution_warning.as_deref(),
        Some("未产生新改动：前置节点已完整实现。按 no-op 完成并进入审核。")
    );
}

#[tokio::test]
async fn implementation_no_diff_without_no_op_reason_still_fails() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    let task = test_task(temp.path());
    let mut output = test_output(None, None);

    let error = stage_task_changes(&task, &mut output).await.unwrap_err();

    assert!(error.to_string().contains("没有产生可提交改动"));
}

#[tokio::test]
async fn fixing_implementation_requires_a_new_commit() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    let old_commit = super::git(temp.path(), &["rev-parse", "HEAD"])
        .await
        .unwrap()
        .trim()
        .to_owned();
    let mut task = test_task(temp.path());
    task.status = RequirementTaskStatus::Fixing;
    let mut output = test_output(Some(false), Some("无需修改"));

    let error = stage_task_changes(&task, &mut output).await.unwrap_err();
    assert!(error.to_string().contains("必须产生实际代码改动"));

    tokio::fs::write(temp.path().join("README.md"), "fixed\n")
        .await
        .unwrap();
    let mut output = test_output(Some(true), None);
    stage_task_changes(&task, &mut output).await.unwrap();
    commit_staged_changes(temp.path(), "raccoon_node: 实现功能")
        .await
        .unwrap();
    let new_commit = super::git(temp.path(), &["rev-parse", "HEAD"])
        .await
        .unwrap()
        .trim()
        .to_owned();
    assert_ne!(new_commit, old_commit);
}

#[tokio::test]
async fn staged_changes_are_ready_for_review() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    let task = test_task(temp.path());
    let mut output = test_output(Some(true), None);

    tokio::fs::write(temp.path().join("README.md"), "staged\n")
        .await
        .unwrap();
    stage_task_changes(&task, &mut output).await.unwrap();

    let status = super::git(temp.path(), &["status", "--porcelain"])
        .await
        .unwrap();
    let diff = super::git(temp.path(), &["diff", "--cached"])
        .await
        .unwrap();
    let log_count = super::git(temp.path(), &["rev-list", "--count", "HEAD"])
        .await
        .unwrap();
    assert!(!status.trim().is_empty());
    assert!(diff.contains("staged"));
    assert_eq!(log_count.trim(), "1");
}

async fn init_repo(path: &Path) {
    super::git(path, &["init"]).await.unwrap();
    super::git(path, &["config", "user.email", "test@example.com"])
        .await
        .unwrap();
    super::git(path, &["config", "user.name", "Test"])
        .await
        .unwrap();
    super::git(path, &["config", "core.autocrlf", "false"])
        .await
        .unwrap();
    tokio::fs::write(path.join("README.md"), "test\n")
        .await
        .unwrap();
    super::git(path, &["add", "README.md"]).await.unwrap();
    super::git(path, &["commit", "-m", "init"]).await.unwrap();
}

fn test_task(path: &Path) -> crate::models::RequirementExecutionTask {
    crate::models::RequirementExecutionTask {
        id: "task-1".to_owned(),
        title: "实现功能".to_owned(),
        description: "只做当前功能".to_owned(),
        depends_on: Vec::new(),
        kind: RequirementTaskKind::Implementation,
        model_tier: RequirementModelTier::Medium,
        timeout_seconds: 60,
        pi_session_file: None,
        branch_name: None,
        worktree_path: Some(path.to_string_lossy().to_string()),
        review_for: None,
        review_angle: None,
        review_status: RequirementReviewStatus::Pending,
        review_history: Vec::new(),
        attempt: 0,
        execution_failure_count: 0,
        review_rejection_count: 0,
        recovery_stage: crate::models::RequirementRecoveryStage::None,
        failure_summary: None,
        recovery_guidance: None,
        high_tier_execution_used: false,
        last_review_feedback: None,
        pull_request_url: None,
        merged_into: None,
        cleanup_summary: None,
        execution_warning: None,
        trace: None,
        status: RequirementTaskStatus::Running,
        target_files: Vec::new(),
        result_summary: None,
        error: None,
    }
}

fn test_output(
    changed: Option<bool>,
    no_op_reason: Option<&str>,
) -> RequirementTaskExecutionOutput {
    RequirementTaskExecutionOutput {
        result_summary: "完成".to_owned(),
        pi_session_file: None,
        branch_name: None,
        worktree_path: None,
        review_status: None,
        review_feedback: None,
        pull_request_url: None,
        merged_into: None,
        cleanup_summary: None,
        execution_warning: None,
        changed,
        no_op_reason: no_op_reason.map(str::to_owned),
        recovery_guidance: None,
        trace: Some(serde_json::json!({ "type": "pi_trace" })),
    }
}
