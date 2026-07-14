use super::*;
use chrono::Utc;

#[tokio::test]
async fn unsupported_database_schema_is_rejected() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("data.db");
    let connection = rusqlite::Connection::open(db_path).unwrap();
    connection
        .execute_batch("CREATE TABLE unknown_schema (id TEXT PRIMARY KEY);")
        .unwrap();
    drop(connection);

    let error = Store::open(temp_dir.path().to_path_buf())
        .await
        .err()
        .expect("future schema must fail");
    assert!(error.to_string().contains("删除项目的 .raccoon-node"));
}

#[tokio::test]
async fn damaged_current_database_is_rejected_instead_of_repaired() {
    let temp_dir = tempfile::tempdir().unwrap();
    let data_root = temp_dir.path().to_path_buf();
    drop(Store::open(data_root.clone()).await.unwrap());
    let connection = rusqlite::Connection::open(data_root.join("data.db")).unwrap();
    connection
        .execute("ALTER TABLE project_chats DROP COLUMN pi_session_file", [])
        .unwrap();
    drop(connection);

    let error = Store::open(data_root.clone())
        .await
        .err()
        .expect("damaged schema must fail");
    assert!(error.to_string().contains("数据库结构与当前构建不一致"));
}
use crate::error::AppError;
use crate::models::{
    AcceptanceScenario, ChangeSpec, ExplicitConstraint, Project, ProjectChat, ProjectChatMessage,
    ProjectChatMessageRole, Requirement, RequirementFailureStage, RequirementMessage,
    RequirementMessageRole, RequirementStatus,
};

fn test_project(root: &Path) -> Project {
    Project {
        name: "project".to_owned(),
        git_url: "https://example.com/project.git".to_owned(),
        local_path: root.to_string_lossy().into_owned(),
    }
}

#[tokio::test]
async fn project_scheduler_claims_confirmed_requirements_in_fifo_order() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.project = test_project(temp_dir.path());
    let mut second = queued_requirement("second", now + chrono::Duration::seconds(2));
    second.updated_at = now - chrono::Duration::days(1);
    let first = queued_requirement("first", now + chrono::Duration::seconds(1));
    store.data.requirements = vec![second, first];
    store.persist().await.unwrap();

    let action = store.prepare_next_project_action().await.unwrap().unwrap();

    assert!(matches!(
        action,
        super::ProjectScheduleAction::Plan {
            requirement_id,
            ..
        } if requirement_id == "first"
    ));
    assert_eq!(
        store.data.requirements[1].status,
        RequirementStatus::Planning
    );
    let persisted = store
        .db
        .load()
        .unwrap()
        .requirements
        .into_iter()
        .find(|requirement| requirement.id == "first")
        .unwrap();
    assert_eq!(
        persisted.queued_at,
        Some(now + chrono::Duration::seconds(1))
    );
}

#[tokio::test]
async fn failed_requirement_pauses_project_queue() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.project = test_project(temp_dir.path());
    let mut failed = queued_requirement("failed", now);
    failed.status = RequirementStatus::Failed;
    failed.error = Some("规划失败".to_owned());
    store.data.requirements = vec![
        failed,
        queued_requirement("waiting", now + chrono::Duration::seconds(1)),
    ];
    store.persist().await.unwrap();

    assert!(store.prepare_next_project_action().await.unwrap().is_none());
    assert_eq!(store.data.requirements[1].status, RequirementStatus::Queued);
}

#[tokio::test]
async fn invalid_failed_change_spec_routes_to_repair_before_planning() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.project = test_project(temp_dir.path());
    let message = |role, content: &str| RequirementMessage {
        role,
        content: content.to_owned(),
        references: Vec::new(),
        images: Vec::new(),
        metadata: None,
        created_at: now,
    };
    let mut failed = requirement("webgl");
    failed.status = RequirementStatus::Failed;
    failed.failure_stage = Some(RequirementFailureStage::ChangeSpecValidation);
    failed.pi_session_file = Some("requirement.jsonl".to_owned());
    failed.messages = vec![
        message(RequirementMessageRole::User, "修复 WebGL 不可用问题"),
        message(RequirementMessageRole::Assistant, "需要澄清"),
        message(RequirementMessageRole::Trace, "trace"),
        message(
            RequirementMessageRole::User,
            "期望的修复策略是什么？：强制 WebGL 并优化检测",
        ),
    ];
    failed.draft = Some(ChangeSpec {
        intent: "修复 WebGL 不可用问题".to_owned(),
        acceptance_scenarios: vec![AcceptanceScenario {
            id: "start".to_owned(),
            given: "浏览器支持三维渲染".to_owned(),
            when: "用户进入游戏".to_owned(),
            then: "游戏正常启动".to_owned(),
        }],
        explicit_constraints: vec![ExplicitConstraint {
            id: "strategy".to_owned(),
            statement: "强制 WebGL 并优化检测".to_owned(),
            source_message_id: "clarification_answer".to_owned(),
            source_quote: "策略：强制 WebGL 并优化检测".to_owned(),
        }],
        non_goals: Vec::new(),
    });
    store.data.requirements.push(failed);
    store.persist().await.unwrap();

    let action = store.requeue_failed_planning("webgl").await.unwrap();
    let super::FailedRequirementWorkflowAction::RepairChangeSpec { input, .. } = action else {
        panic!("invalid ChangeSpec must not start Planner");
    };
    assert!(input.repair_change_spec_only);
    assert_eq!(input.pi_session_file.as_deref(), Some("requirement.jsonl"));
    assert_eq!(
        store.data.requirements[0].status,
        RequirementStatus::Analyzing
    );
}

#[tokio::test]
async fn confirmation_rejects_invalid_constraint_evidence_before_queueing() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let mut draft = requirement("invalid-confirmation");
    draft.status = RequirementStatus::DraftReady;
    let invalid_spec = ChangeSpec {
        intent: "修复启动".to_owned(),
        acceptance_scenarios: vec![AcceptanceScenario {
            id: "start".to_owned(),
            given: "环境正常".to_owned(),
            when: "用户启动应用".to_owned(),
            then: "应用正常运行".to_owned(),
        }],
        explicit_constraints: vec![ExplicitConstraint {
            id: "runtime".to_owned(),
            statement: "使用浏览器".to_owned(),
            source_message_id: "initial_request".to_owned(),
            source_quote: "浏览器".to_owned(),
        }],
        non_goals: Vec::new(),
    };
    draft.draft = Some(invalid_spec.clone());
    draft.active_prompt = Some(crate::models::RequirementPromptState::Confirmation {
        prompt_id: "prompt-1".to_owned(),
        revision: 1,
        draft: invalid_spec,
    });
    store.data.requirements.push(draft);
    store.persist().await.unwrap();

    assert!(
        store
            .confirm_requirement("invalid-confirmation", "prompt-1".to_owned(), 1)
            .await
            .is_err()
    );
    let requirement = &store.data.requirements[0];
    assert_eq!(requirement.status, RequirementStatus::Failed);
    assert_eq!(
        requirement.failure_stage,
        Some(RequirementFailureStage::ChangeSpecValidation)
    );
    assert!(requirement.queued_at.is_none());
}

#[tokio::test]
async fn planning_preflight_rejects_invalid_spec_before_creating_an_action() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.project = test_project(temp_dir.path());
    let mut queued = queued_requirement("invalid-preflight", now);
    queued.draft.as_mut().unwrap().explicit_constraints = vec![ExplicitConstraint {
        id: "runtime".to_owned(),
        statement: "使用浏览器".to_owned(),
        source_message_id: "initial_request".to_owned(),
        source_quote: "浏览器".to_owned(),
    }];
    store.data.requirements.push(queued);
    store.persist().await.unwrap();

    assert!(
        store
            .start_requirement_planning("invalid-preflight")
            .await
            .is_err()
    );
    let requirement = &store.data.requirements[0];
    assert_eq!(requirement.status, RequirementStatus::Failed);
    assert_eq!(
        requirement.failure_code.as_deref(),
        Some("planning_preflight_failed")
    );
}

#[tokio::test]
async fn evidence_only_repair_auto_queues_but_semantic_changes_require_confirmation() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let mut repaired = requirement("webgl");
    repaired.status = RequirementStatus::DraftReady;
    repaired.messages[0].content = "强制 WebGL 并优化检测".to_owned();
    let baseline = ChangeSpec {
        intent: "修复游戏启动".to_owned(),
        acceptance_scenarios: vec![AcceptanceScenario {
            id: "start".to_owned(),
            given: "浏览器支持三维渲染".to_owned(),
            when: "用户进入游戏".to_owned(),
            then: "游戏正常启动".to_owned(),
        }],
        explicit_constraints: vec![ExplicitConstraint {
            id: "strategy".to_owned(),
            statement: "强制 WebGL 并优化检测".to_owned(),
            source_message_id: "invalid".to_owned(),
            source_quote: "invalid".to_owned(),
        }],
        non_goals: Vec::new(),
    };
    let mut fixed = baseline.clone();
    fixed.explicit_constraints[0].source_message_id = "message-1".to_owned();
    fixed.explicit_constraints[0].source_quote = "强制 WebGL 并优化检测".to_owned();
    repaired.draft = Some(fixed);
    store.data.requirements.push(repaired);
    store.persist().await.unwrap();

    assert!(
        store
            .auto_queue_repaired_requirement("webgl", &baseline)
            .await
            .unwrap()
    );
    assert_eq!(store.data.requirements[0].status, RequirementStatus::Queued);

    store.data.requirements[0].status = RequirementStatus::DraftReady;
    store.data.requirements[0].draft.as_mut().unwrap().intent = "改变后的目标".to_owned();
    store.persist().await.unwrap();
    assert!(
        !store
            .auto_queue_repaired_requirement("webgl", &baseline)
            .await
            .unwrap()
    );
    assert_eq!(
        store.data.requirements[0].status,
        RequirementStatus::DraftReady
    );
}

#[tokio::test]
async fn running_requirement_without_workflow_is_failed_before_queue_advances() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.project = test_project(temp_dir.path());
    let running = requirement("running");
    let waiting = queued_requirement("waiting", now);
    store.data.requirements = vec![running, waiting];
    store.persist().await.unwrap();

    assert!(store.prepare_next_project_action().await.unwrap().is_none());
    assert_eq!(store.data.requirements[0].status, RequirementStatus::Failed);
    assert_eq!(
        store.data.requirements[0].failure_code.as_deref(),
        Some("workflow_missing")
    );
}

#[tokio::test]
async fn project_store_uses_flat_data_directories_and_runtime_context() {
    let temp_dir = tempfile::tempdir().unwrap();
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(temp_dir.path())
            .status()
            .unwrap()
            .success()
    );
    let data_root = temp_dir.path().join(".raccoon-node");
    let store = Store::open_project(temp_dir.path().to_path_buf())
        .await
        .unwrap();

    assert_eq!(
        Path::new(&store.project.local_path),
        crate::utils::normalize_local_path(&std::fs::canonicalize(temp_dir.path()).unwrap())
            .unwrap()
    );
    for directory in ["sessions", "worktrees", "attachments"] {
        assert!(data_root.join(directory).is_dir());
    }
    assert!(!data_root.join("projects").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn project_store_rejects_data_directory_symlink_escape() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(project.path())
            .status()
            .unwrap()
            .success()
    );
    std::os::unix::fs::symlink(outside.path(), project.path().join(".raccoon-node")).unwrap();

    assert!(
        Store::open_project(project.path().to_path_buf())
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn resetting_project_chat_clears_context_and_rejects_running_chat() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.project = test_project(temp_dir.path());
    store.project_chat_response().await.unwrap();
    let chat = &mut store.data.project_chats[0];
    chat.messages.push(ProjectChatMessage {
        role: ProjectChatMessageRole::User,
        content: "问题".to_owned(),
        references: Vec::new(),
        images: Vec::new(),
        metadata: None,
        created_at: now,
    });
    chat.error = Some("旧错误".to_owned());
    chat.pi_session_file = Some("old.jsonl".to_owned());
    store.persist().await.unwrap();
    let response = store.reset_project_chat().await.unwrap();
    assert!(response.messages.is_empty());
    assert!(response.error.is_none());
    assert!(store.data.project_chats[0].pi_session_file.is_none());

    store.data.project_chats[0].running = true;
    store.persist().await.unwrap();
    assert!(store.reset_project_chat().await.is_err());
}

#[tokio::test]
async fn requirement_branch_input_distinguishes_fresh_clone_and_running_chat() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.project = test_project(temp_dir.path());

    assert!(
        store
            .start_project_chat_requirement_branch()
            .await
            .unwrap()
            .is_none()
    );

    let chat = &mut store.data.project_chats[0];
    chat.pi_session_file = Some("main.jsonl".to_owned());
    chat.messages.push(ProjectChatMessage {
        role: ProjectChatMessageRole::User,
        content: "现有项目上下文".to_owned(),
        references: Vec::new(),
        images: Vec::new(),
        metadata: None,
        created_at: now,
    });
    chat.messages.push(ProjectChatMessage {
        role: ProjectChatMessageRole::Assistant,
        content: "已完成回复".to_owned(),
        references: Vec::new(),
        images: Vec::new(),
        metadata: None,
        created_at: now,
    });
    store.persist().await.unwrap();
    let input = store
        .start_project_chat_requirement_branch()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(input.pi_session_file.as_deref(), Some("main.jsonl"));
    assert_eq!(input.messages.len(), 2);
    store
        .finish_project_chat_requirement_branch()
        .await
        .unwrap();

    store
        .create_requirement_with_session(
            "使用分支上下文生成需求".to_owned(),
            Vec::new(),
            Vec::new(),
            Some("branch.jsonl".to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(
        store.data.requirements[0].pi_session_file.as_deref(),
        Some("branch.jsonl")
    );
    assert_eq!(
        store.data.requirements[0].origin,
        crate::models::RequirementOrigin::ProjectChatBranch
    );
    assert_eq!(
        store.data.project_chats[0].pi_session_file.as_deref(),
        Some("main.jsonl")
    );

    store.data.project_chats[0].running = true;
    store.persist().await.unwrap();
    assert!(store.start_project_chat_requirement_branch().await.is_err());
}

#[tokio::test]
async fn complete_chat_without_parent_session_does_not_fall_back_to_standalone() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.project = test_project(temp_dir.path());
    store.project_chat_response().await.unwrap();
    for (role, content) in [
        (ProjectChatMessageRole::User, "问题"),
        (ProjectChatMessageRole::Assistant, "回答"),
    ] {
        store.data.project_chats[0]
            .messages
            .push(ProjectChatMessage {
                role,
                content: content.to_owned(),
                references: Vec::new(),
                images: Vec::new(),
                metadata: None,
                created_at: now,
            });
    }
    store.persist().await.unwrap();
    let error = store
        .start_project_chat_requirement_branch()
        .await
        .unwrap_err();
    assert!(error.to_string().contains("session 已丢失"));
    assert!(!store.data.project_chats[0].running);
    assert!(store.data.requirements.is_empty());
}

#[tokio::test]
async fn active_requirement_blocks_project_chat_send_and_reset() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    store.project = test_project(temp_dir.path());
    store.project_chat_response().await.unwrap();
    let mut active = requirement("active");
    active.status = RequirementStatus::Clarifying;
    store.data.requirements.push(active);
    store.persist().await.unwrap();

    assert!(
        store
            .start_project_chat_message("继续".to_owned(), Vec::new(), Vec::new())
            .await
            .is_err()
    );
    assert!(store.reset_project_chat().await.is_err());
}

fn requirement(id: &str) -> Requirement {
    let now = Utc::now();
    Requirement {
        id: id.to_owned(),
        title: id.to_owned(),
        origin: crate::models::RequirementOrigin::Standalone,
        status: RequirementStatus::Running,
        messages: vec![RequirementMessage {
            role: RequirementMessageRole::User,
            content: id.to_owned(),
            references: Vec::new(),
            images: Vec::new(),
            metadata: None,
            created_at: now,
        }],
        clarification_round: 0,
        clarifications: Vec::new(),
        draft: None,
        analysis_revision: 0,
        active_prompt: None,
        clarification_history: Vec::new(),
        pi_session_file: None,
        error: None,
        failure_stage: None,
        failure_code: None,
        queued_at: None,
        created_at: now,
        updated_at: now,
    }
}

fn queued_requirement(id: &str, queued_at: chrono::DateTime<Utc>) -> Requirement {
    let mut requirement = requirement(id);
    requirement.status = RequirementStatus::Queued;
    requirement.draft = Some(ChangeSpec {
        intent: id.to_owned(),
        acceptance_scenarios: vec![AcceptanceScenario {
            id: format!("scenario-{id}"),
            given: "初始状态成立".to_owned(),
            when: "用户执行操作".to_owned(),
            then: "得到预期结果".to_owned(),
        }],
        explicit_constraints: Vec::new(),
        non_goals: Vec::new(),
    });
    requirement.queued_at = Some(queued_at);
    requirement
}

fn project_chat_with_usage(usage: serde_json::Value) -> ProjectChat {
    let now = Utc::now();
    ProjectChat {
        messages: vec![ProjectChatMessage {
            role: ProjectChatMessageRole::Assistant,
            content: "回答".to_owned(),
            references: Vec::new(),
            images: Vec::new(),
            metadata: Some(serde_json::json!({
                "type": "pi_trace",
                "trace": { "usage": usage }
            })),
            created_at: now,
        }],
        running: false,
        error: None,
        pi_session_file: None,
        created_at: now,
        updated_at: now,
    }
}

#[tokio::test]
async fn failed_project_chat_operation_trace_is_persisted_and_aggregated() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let mut chat = project_chat_with_usage(serde_json::json!({}));
    chat.messages.clear();
    chat.running = true;
    store.data.project_chats.push(chat);
    store.persist().await.unwrap();
    let trace = serde_json::json!({
        "type": "pi_trace",
        "trace": {
            "operationId": "chat-failure",
            "usage": {
                "scope": "operation",
                "input": 13,
                "output": 2,
                "cacheRead": 1,
                "cacheWrite": 0
            }
        }
    });

    store
        .apply_project_chat_result(Err(AppError::task_execution_with_trace(
            "timeout",
            Some("chat.jsonl".to_owned()),
            Some(trace.clone()),
        )))
        .await
        .unwrap();

    let chat = &store.data.project_chats[0];
    assert!(!chat.running);
    assert!(chat.messages.iter().any(|message| {
        message.role == ProjectChatMessageRole::System && message.metadata.as_ref() == Some(&trace)
    }));
    let usage = aggregate_project_token_usage(
        store.data.project_chats.iter(),
        std::iter::empty(),
        std::iter::empty(),
    )
    .unwrap();
    assert_eq!(usage.chat.input, 13);
    assert_eq!(usage.chat.output, 2);
}

#[test]
fn aggregate_token_usage_includes_compaction_estimates_without_billing_them() {
    let mut chat = project_chat_with_usage(serde_json::json!({
        "scope": "operation",
        "input": 100,
        "output": 10,
        "cacheRead": 0,
        "cacheWrite": 0,
    }));
    chat.messages[0].metadata.as_mut().unwrap()["trace"]["compaction"] = serde_json::json!({
        "usageKnown": false,
        "count": 2,
        "completed": 1,
        "aborted": 0,
        "failed": 1,
        "overflowRetries": 1,
        "estimatedTokensSaved": 7_500,
    });

    let usage = aggregate_project_token_usage(
        vec![&chat].into_iter(),
        std::iter::empty(),
        std::iter::empty(),
    )
    .unwrap();
    let compaction = usage.compaction.unwrap();

    assert_eq!(usage.total.input, 100);
    assert_eq!(compaction.count, 2);
    assert_eq!(compaction.completed, 1);
    assert_eq!(compaction.failed, 1);
    assert_eq!(compaction.overflow_retries, 1);
    assert_eq!(compaction.estimated_tokens_saved, 7_500);
    assert!(!compaction.usage_known);
}
