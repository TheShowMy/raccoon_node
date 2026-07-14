use super::transport::PiRpcTransportConfig;
use super::{
    OperationRuntimeObservation, TaskGitState, assistant_message_input,
    attach_auto_compaction_state, attach_compaction_observability, attach_runtime_observation,
    attach_session_usage, build_failure_trace, event_has_output_activity, is_terminal_agent_end,
    next_terminal_pending, parse_session_header_cwd, parse_workflow_payload,
    resolve_project_working_dir, session_header_matches_working_dir,
};
use std::path::Path;
use std::time::Duration;

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
fn review_transport_disables_user_resources_and_limits_parent_tools() {
    let config = PiRpcTransportConfig::session_with_tools(
        "pi",
        Path::new("/tmp/sessions"),
        Path::new("/tmp/repo"),
        &[],
        "run_parallel_code_review",
    );
    let args = config.extra_args();
    for expected in [
        "--no-extensions",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--tools",
        "run_parallel_code_review",
    ] {
        assert!(args.iter().any(|arg| arg == expected), "missing {expected}");
    }
}

#[test]
fn workflow_payload_requires_exactly_one_valid_managed_submission() {
    let valid = serde_json::json!({
        "type": "tool_execution_end",
        "toolName": "submit_work_plan",
        "result": {
            "details": {
                "protocol": "raccoon:workflow-output",
                "kind": "work_plan",
                "payload": {
                    "summary": "plan",
                    "design_notes": [],
                    "work_items": []
                }
            }
        }
    });

    let payload = parse_workflow_payload(
        std::slice::from_ref(&valid),
        "submit_work_plan",
        "work_plan",
    )
    .unwrap();
    assert_eq!(payload["summary"], "plan");

    assert!(
        parse_workflow_payload(&[], "submit_work_plan", "work_plan")
            .unwrap_err()
            .to_string()
            .contains("实际为 0 次")
    );
    assert!(
        parse_workflow_payload(
            &[valid.clone(), valid.clone()],
            "submit_work_plan",
            "work_plan",
        )
        .unwrap_err()
        .to_string()
        .contains("实际为 2 次")
    );

    let mut invalid_protocol = valid.clone();
    invalid_protocol["result"]["details"]["protocol"] = serde_json::json!("unsupported");
    assert!(
        parse_workflow_payload(&[invalid_protocol], "submit_work_plan", "work_plan",)
            .unwrap_err()
            .to_string()
            .contains("输出协议不匹配")
    );

    let mut invalid_kind = valid;
    invalid_kind["result"]["details"]["kind"] = serde_json::json!("task_result");
    assert!(
        parse_workflow_payload(&[invalid_kind], "submit_work_plan", "work_plan",)
            .unwrap_err()
            .to_string()
            .contains("结果类型不匹配")
    );
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
fn terminal_settle_waits_for_compaction_and_overflow_retry() {
    let agent_end = serde_json::json!({ "type": "agent_end", "willRetry": false });
    let mut pending = next_terminal_pending(false, &agent_end, true);
    assert!(pending);

    pending = next_terminal_pending(
        pending,
        &serde_json::json!({ "type": "compaction_start", "reason": "overflow" }),
        false,
    );
    assert!(!pending);
    pending = next_terminal_pending(
        pending,
        &serde_json::json!({
            "type": "compaction_end",
            "reason": "overflow",
            "willRetry": true
        }),
        false,
    );
    assert!(!pending);
    pending = next_terminal_pending(
        pending,
        &serde_json::json!({ "type": "agent_end", "willRetry": false }),
        true,
    );
    assert!(pending);
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
    assert!(event_has_output_activity(&serde_json::json!({
        "type": "compaction_start",
        "reason": "threshold"
    })));
    assert!(event_has_output_activity(&serde_json::json!({
        "type": "compaction_end",
        "reason": "threshold",
        "aborted": false
    })));
    assert!(event_has_output_activity(&serde_json::json!({
        "type": "tool_execution_start",
        "toolName": "bash"
    })));
    assert!(event_has_output_activity(&serde_json::json!({
        "type": "turn_end"
    })));
    assert!(event_has_output_activity(&serde_json::json!({
        "type": "auto_retry_start"
    })));
}

#[test]
fn event_activity_ignores_response_and_empty_deltas() {
    assert!(!event_has_output_activity(&serde_json::json!({
        "type": "response",
        "success": true
    })));
    assert!(event_has_output_activity(&serde_json::json!({
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
fn runtime_observation_records_non_enforcing_budget_warning() {
    let trace = Some(serde_json::json!({
        "type": "pi_trace",
        "trace": {}
    }));
    let mut observation = OperationRuntimeObservation::new(
        Duration::from_secs(120),
        Duration::from_secs(600),
        Some(250_000),
    );
    observation.observed_input = 281_178;
    observation.budget_warning_emitted = true;
    observation.activity_count = 42;
    observation.termination_reason = "completed";

    let trace = attach_runtime_observation(trace, &observation).unwrap();
    assert_eq!(trace["trace"]["budget"]["exceeded"], true);
    assert_eq!(trace["trace"]["budget"]["enforced"], false);
    assert_eq!(trace["trace"]["budget"]["observed"], 281_178);
    assert_eq!(trace["trace"]["runtime"]["absoluteTimeout"], false);
    assert_eq!(trace["trace"]["runtime"]["activityCount"], 42);
}

#[test]
fn session_stats_are_normalized_into_trace_usage() {
    let trace = Some(serde_json::json!({
        "type": "pi_trace",
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
        None,
    )
    .unwrap();

    assert_eq!(trace["trace"]["usage"]["sessionReused"], true);
    assert_eq!(trace["trace"]["usage"]["callCount"], 3);
    assert_eq!(trace["trace"]["usage"]["cacheRead"], 1000);
    assert_eq!(trace["trace"]["usage"]["context"]["window"], 128000);
}

#[test]
fn compaction_events_are_normalized_without_summary_or_billing_usage() {
    let events = vec![
        serde_json::json!({ "type": "compaction_start", "reason": "overflow" }),
        serde_json::json!({
            "type": "compaction_end",
            "reason": "overflow",
            "result": {
                "summary": "sensitive summary",
                "tokensBefore": 12_000,
                "estimatedTokensAfter": 4_500
            },
            "aborted": false,
            "willRetry": true
        }),
        serde_json::json!({ "type": "compaction_start", "reason": "threshold" }),
        serde_json::json!({
            "type": "compaction_end",
            "reason": "threshold",
            "aborted": true,
            "willRetry": false
        }),
    ];
    let trace =
        attach_compaction_observability(Some(serde_json::json!({ "trace": {} })), &events).unwrap();
    let compaction = &trace["trace"]["compaction"];

    assert_eq!(compaction["count"], 2);
    assert_eq!(compaction["completed"], 1);
    assert_eq!(compaction["aborted"], 1);
    assert_eq!(compaction["overflowRetries"], 1);
    assert_eq!(compaction["estimatedTokensSaved"], 7_500);
    assert_eq!(compaction["usageKnown"], false);
    assert_eq!(compaction["events"][0]["status"], "completed");
    assert_eq!(compaction["events"][0]["estimatedTokensAfter"], 4_500);
    assert!(!trace.to_string().contains("sensitive summary"));
}

#[test]
fn auto_compaction_state_records_pi_setting_without_changing_it() {
    let trace = attach_auto_compaction_state(Some(serde_json::json!({ "trace": {} })), Some(false))
        .unwrap();

    assert_eq!(trace["trace"]["compaction"]["autoEnabled"], false);
    assert_eq!(trace["trace"]["compaction"]["count"], 0);
    assert_eq!(trace["trace"]["compaction"]["usageKnown"], false);
}

#[test]
fn compaction_failure_preserves_reason_and_error_without_estimates() {
    let trace = attach_compaction_observability(
        Some(serde_json::json!({ "trace": {} })),
        &[serde_json::json!({
            "type": "compaction_end",
            "reason": "threshold",
            "result": null,
            "aborted": false,
            "willRetry": false,
            "errorMessage": "Auto-compaction failed: provider unavailable"
        })],
    )
    .unwrap();
    let event = &trace["trace"]["compaction"]["events"][0];

    assert_eq!(trace["trace"]["compaction"]["failed"], 1);
    assert_eq!(event["reason"], "threshold");
    assert_eq!(event["status"], "failed");
    assert_eq!(
        event["error"],
        "Auto-compaction failed: provider unavailable"
    );
    assert!(event.get("estimatedTokensAfter").is_none());
}

#[test]
fn session_stats_use_operation_delta_when_baseline_is_available() {
    let trace = attach_session_usage(
        Some(serde_json::json!({ "trace": {} })),
        &serde_json::json!({
            "assistantMessages": 5,
            "tokens": { "input": 150, "output": 60, "cacheRead": 30, "cacheWrite": 10 },
            "contextUsage": { "tokens": 100, "contextWindow": 1000, "percent": 10.0 }
        }),
        true,
        Some(&serde_json::json!({
            "assistantMessages": 3,
            "tokens": { "input": 100, "output": 40, "cacheRead": 20, "cacheWrite": 5 }
        })),
    )
    .unwrap();
    assert_eq!(trace["trace"]["usage"]["scope"], "operation");
    assert_eq!(trace["trace"]["usage"]["callCount"], 2);
    assert_eq!(trace["trace"]["usage"]["input"], 50);
    assert_eq!(trace["trace"]["usage"]["cacheWrite"], 5);
}

#[test]
fn failure_trace_counts_assistant_operation_usage() {
    let events = vec![serde_json::json!({
        "type": "message_end",
        "message": {
            "role": "assistant",
            "usage": { "input": 120, "output": 30, "cacheRead": 40, "cacheWrite": 5 }
        }
    })];

    assert_eq!(assistant_message_input(&events[0]), 120);
    let trace = build_failure_trace(&events, true).unwrap();
    assert_eq!(trace["trace"]["usage"]["scope"], "operation");
    assert_eq!(trace["trace"]["usage"]["input"], 120);
    assert_eq!(trace["trace"]["usage"]["cacheRead"], 40);
    assert!(trace["trace"]["operationId"].as_str().is_some());
}

#[tokio::test]
async fn task_git_state_allows_unstaged_code_edits_but_rejects_staged_changes() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    let state = TaskGitState::capture(temp.path()).await.unwrap();

    tokio::fs::write(temp.path().join("README.md"), "unstaged\n")
        .await
        .unwrap();
    state.verify(temp.path()).await.unwrap();

    super::git(temp.path(), &["add", "README.md"])
        .await
        .unwrap();
    let error = state.verify(temp.path()).await.unwrap_err();
    assert!(error.to_string().contains("修改了暂存区"));
}

#[tokio::test]
async fn task_git_state_rejects_head_and_branch_changes() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path()).await;
    let head_state = TaskGitState::capture(temp.path()).await.unwrap();

    tokio::fs::write(temp.path().join("README.md"), "committed\n")
        .await
        .unwrap();
    super::git(temp.path(), &["add", "README.md"])
        .await
        .unwrap();
    super::git(temp.path(), &["commit", "-m", "bypass"])
        .await
        .unwrap();
    let error = head_state.verify(temp.path()).await.unwrap_err();
    assert!(error.to_string().contains("修改了 HEAD"));

    let branch_state = TaskGitState::capture(temp.path()).await.unwrap();
    super::git(temp.path(), &["switch", "-c", "other"])
        .await
        .unwrap();
    let error = branch_state.verify(temp.path()).await.unwrap_err();
    assert!(error.to_string().contains("修改了当前分支"));
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
