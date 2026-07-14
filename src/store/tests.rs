use super::*;
use chrono::Utc;

#[tokio::test]
async fn unsupported_database_schema_is_rejected() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("data.db");
    let connection = rusqlite::Connection::open(db_path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version VALUES (99);",
        )
        .unwrap();
    drop(connection);

    let error = JsonStore::open(temp_dir.path().to_path_buf())
        .await
        .err()
        .expect("future schema must fail");
    assert!(error.to_string().contains("不支持的数据库版本"));
}

#[tokio::test]
async fn damaged_current_database_is_rejected_instead_of_repaired() {
    let temp_dir = tempfile::tempdir().unwrap();
    let data_root = temp_dir.path().to_path_buf();
    drop(JsonStore::open(data_root.clone()).await.unwrap());
    let connection = rusqlite::Connection::open(data_root.join("data.db")).unwrap();
    connection
        .execute("ALTER TABLE project_chats DROP COLUMN pi_session_file", [])
        .unwrap();
    drop(connection);

    let error = JsonStore::open(data_root.clone())
        .await
        .err()
        .expect("damaged v4 schema must fail");
    assert!(error.to_string().contains("pi_session_file"));
}

#[tokio::test]
async fn old_non_v3_database_is_rejected_without_runtime_migration() {
    let temp_dir = tempfile::tempdir().unwrap();
    let data_root = temp_dir.path().to_path_buf();
    drop(JsonStore::open(data_root.clone()).await.unwrap());
    let connection = rusqlite::Connection::open(data_root.join("data.db")).unwrap();
    connection
        .execute_batch("UPDATE schema_version SET version = 2;")
        .unwrap();
    drop(connection);

    let error = JsonStore::open(data_root)
        .await
        .err()
        .expect("v2 database must not be migrated at runtime");
    assert!(error.to_string().contains("不支持的数据库版本：2"));
}

#[tokio::test]
async fn version_four_database_is_byte_archived_and_replaced() {
    let temp_dir = tempfile::tempdir().unwrap();
    let data_root = temp_dir.path().to_path_buf();
    drop(JsonStore::open(data_root.clone()).await.unwrap());
    let connection = rusqlite::Connection::open(data_root.join("data.db")).unwrap();
    connection
        .execute_batch(
            "INSERT INTO requirements
             (id, project_id, title, original_message, status, messages,
              clarification_round, clarifications, analysis_revision,
              clarification_history, created_at, updated_at, origin)
             VALUES
             ('req-v4', 'current', '归档需求', '只能存在于归档', 'failed', '[]',
              0, '[]', 0, '[]', '2026-07-10T00:00:00Z',
              '2026-07-10T00:00:00Z', 'standalone');
             UPDATE schema_version SET version = 4;",
        )
        .unwrap();
    drop(connection);

    let store = JsonStore::open(data_root.clone()).await.unwrap();
    assert!(store.data.requirements.is_empty());
    let archive_root = data_root.join("archive");
    let archive = std::fs::read_dir(&archive_root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("workflow-v4-")
        })
        .expect("v4 archive must exist");
    assert!(archive.join("manifest.json").exists());
    let archived = rusqlite::Connection::open(archive.join("data.db")).unwrap();
    let count = archived
        .query_row(
            "SELECT COUNT(*) FROM requirements WHERE id = 'req-v4'",
            [],
            |row| row.get::<_, u32>(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
use crate::error::AppError;
use crate::models::{
    AcceptanceScenario, ChangeSpec, Project, ProjectChat, ProjectChatMessage,
    ProjectChatMessageRole, Requirement, RequirementMessage, RequirementMessageRole,
    RequirementStatus,
};

#[tokio::test]
async fn project_scheduler_claims_confirmed_requirements_in_fifo_order() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.data.projects.push(Project {
        id: "project".to_owned(),
        name: "project".to_owned(),
        git_url: "https://example.com/project.git".to_owned(),
        local_path: temp_dir.path().to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
    });
    let mut second = queued_requirement("second", now + chrono::Duration::seconds(2));
    second.updated_at = now - chrono::Duration::days(1);
    let first = queued_requirement("first", now + chrono::Duration::seconds(1));
    store.data.requirements = vec![second, first];

    let action = store
        .prepare_next_project_action("project")
        .await
        .unwrap()
        .unwrap();

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
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.data.projects.push(Project {
        id: "project".to_owned(),
        name: "project".to_owned(),
        git_url: "https://example.com/project.git".to_owned(),
        local_path: temp_dir.path().to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
    });
    let mut failed = queued_requirement("failed", now);
    failed.status = RequirementStatus::Failed;
    failed.error = Some("规划失败".to_owned());
    store.data.requirements = vec![
        failed,
        queued_requirement("waiting", now + chrono::Duration::seconds(1)),
    ];

    assert!(
        store
            .prepare_next_project_action("project")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.data.requirements[1].status, RequirementStatus::Queued);
}

#[tokio::test]
async fn running_requirement_only_blocks_its_own_project() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    for id in ["project-a", "project-b"] {
        store.data.projects.push(Project {
            id: id.to_owned(),
            name: id.to_owned(),
            git_url: format!("https://example.com/{id}.git"),
            local_path: temp_dir.path().join(id).to_string_lossy().to_string(),
            created_at: now,
            updated_at: now,
        });
    }
    let mut running = requirement("running");
    running.project_id = "project-a".to_owned();
    let mut waiting = queued_requirement("waiting", now);
    waiting.project_id = "project-b".to_owned();
    store.data.requirements = vec![running, waiting];

    let action = store
        .prepare_next_project_action("project-b")
        .await
        .unwrap()
        .unwrap();

    assert!(matches!(
        action,
        super::ProjectScheduleAction::Plan {
            requirement_id,
            ..
        } if requirement_id == "waiting"
    ));
    assert_eq!(
        store.data.requirements[0].status,
        RequirementStatus::Running
    );
}

#[tokio::test]
async fn requirement_session_keeps_retry_history_and_paginates() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let session_dir = store.data_root.join("sessions");
    tokio::fs::create_dir_all(&session_dir).await.unwrap();
    for (name, id, timestamp) in [
        ("analysis-1.jsonl", "m1", "2026-07-01T00:00:00Z"),
        ("analysis-2.jsonl", "m2", "2026-07-01T00:01:00Z"),
    ] {
        tokio::fs::write(
            session_dir.join(name),
            format!(
                r#"{{"type":"message","id":"{id}","timestamp":"{timestamp}","message":{{"role":"assistant","content":"reply"}}}}"#
            ),
        )
        .await
        .unwrap();
    }

    let mut active = requirement("req-1");
    active.pi_session_file = Some("analysis-1.jsonl".to_owned());
    store.data.requirements.push(active);
    store.persist().await.unwrap();
    store.data.requirements[0].pi_session_file = Some("analysis-2.jsonl".to_owned());
    store.persist().await.unwrap();

    let page = store.requirement_session("req-1", None, 1).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].source, "需求分析 2");
    assert_eq!(page.next_before, Some(1));

    let earlier = store
        .requirement_session("req-1", page.next_before, 1)
        .unwrap();
    assert_eq!(earlier.entries[0].source, "需求分析 1");
    assert_eq!(earlier.next_before, None);
}

#[tokio::test]
async fn project_store_uses_flat_data_directories_and_current_project() {
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
    let store = JsonStore::open_project(temp_dir.path().to_path_buf())
        .await
        .unwrap();

    assert_eq!(store.data.projects.len(), 1);
    assert_eq!(store.data.projects[0].id, super::CURRENT_PROJECT_ID);
    assert_eq!(
        Path::new(&store.data.projects[0].local_path),
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
        JsonStore::open_project(project.path().to_path_buf())
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn resetting_project_chat_clears_context_and_rejects_running_chat() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.data.projects.push(Project {
        id: "project".to_owned(),
        name: "project".to_owned(),
        git_url: "https://example.com/project.git".to_owned(),
        local_path: store
            .data_root
            .join("projects/project/repo")
            .to_string_lossy()
            .to_string(),
        created_at: now,
        updated_at: now,
    });
    store.project_chat_response("project").await.unwrap();
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
    let response = store.reset_project_chat("project").await.unwrap();
    assert!(response.messages.is_empty());
    assert!(response.error.is_none());
    assert!(store.data.project_chats[0].pi_session_file.is_none());

    store.data.project_chats[0].running = true;
    assert!(store.reset_project_chat("project").await.is_err());
}

#[tokio::test]
async fn requirement_branch_input_distinguishes_fresh_clone_and_running_chat() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.data.projects.push(Project {
        id: "project".to_owned(),
        name: "project".to_owned(),
        git_url: String::new(),
        local_path: temp_dir.path().to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
    });

    assert!(
        store
            .start_project_chat_requirement_branch("project")
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
    let input = store
        .start_project_chat_requirement_branch("project")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(input.pi_session_file.as_deref(), Some("main.jsonl"));
    assert_eq!(input.messages.len(), 2);
    store
        .finish_project_chat_requirement_branch("project")
        .await
        .unwrap();

    store
        .create_requirement_with_session(
            "project",
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
    assert!(
        store
            .start_project_chat_requirement_branch("project")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn complete_chat_without_parent_session_does_not_fall_back_to_standalone() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.data.projects.push(Project {
        id: "project".to_owned(),
        name: "project".to_owned(),
        git_url: String::new(),
        local_path: temp_dir.path().to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
    });
    store.project_chat_response("project").await.unwrap();
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
    let error = store
        .start_project_chat_requirement_branch("project")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("session 已丢失"));
    assert!(!store.data.project_chats[0].running);
    assert!(store.data.requirements.is_empty());
}

#[tokio::test]
async fn active_requirement_blocks_project_chat_send_and_reset() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let now = Utc::now();
    store.data.projects.push(Project {
        id: "project".to_owned(),
        name: "project".to_owned(),
        git_url: String::new(),
        local_path: temp_dir.path().to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
    });
    store.project_chat_response("project").await.unwrap();
    let mut active = requirement("active");
    active.status = RequirementStatus::Clarifying;
    active.project_id = "project".to_owned();
    store.data.requirements.push(active);

    assert!(
        store
            .start_project_chat_message("project", "继续".to_owned(), Vec::new(), Vec::new())
            .await
            .is_err()
    );
    assert!(store.reset_project_chat("project").await.is_err());
}

fn requirement(id: &str) -> Requirement {
    let now = Utc::now();
    Requirement {
        id: id.to_owned(),
        project_id: "project".to_owned(),
        title: id.to_owned(),
        original_message: id.to_owned(),
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

fn project_chat_with_usage(project_id: &str, usage: serde_json::Value) -> ProjectChat {
    let now = Utc::now();
    ProjectChat {
        project_id: project_id.to_owned(),
        messages: vec![ProjectChatMessage {
            role: ProjectChatMessageRole::Assistant,
            content: "回答".to_owned(),
            references: Vec::new(),
            images: Vec::new(),
            metadata: Some(serde_json::json!({
                "type": "pi_trace",
                "version": 1,
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
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let mut chat = project_chat_with_usage("project", serde_json::json!({}));
    chat.messages.clear();
    chat.running = true;
    store.data.project_chats.push(chat);
    let trace = serde_json::json!({
        "type": "pi_trace",
        "version": 2,
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
        .apply_project_chat_result(
            "project",
            Err(AppError::task_execution_with_trace(
                "timeout",
                Some("chat.jsonl".to_owned()),
                Some(trace.clone()),
            )),
        )
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
    let mut chat = project_chat_with_usage(
        "project",
        serde_json::json!({
            "scope": "operation",
            "input": 100,
            "output": 10,
            "cacheRead": 0,
            "cacheWrite": 0,
        }),
    );
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

#[test]
fn session_transcript_normalizes_compaction_without_copying_summary_into_blocks() {
    let temp_dir = tempfile::tempdir().unwrap();
    let session = temp_dir.path().join("session.jsonl");
    std::fs::write(
        &session,
        serde_json::json!({
            "type": "compaction",
            "id": "compact-1",
            "timestamp": "2026-07-01T00:00:00Z",
            "summary": "sensitive compacted context",
            "firstKeptEntryId": "message-42",
            "tokensBefore": 12_000,
            "details": {
                "readFiles": ["src/main.rs", "src/pi/mod.rs"],
                "modifiedFiles": ["src/pi/mod.rs"]
            },
            "fromHook": false
        })
        .to_string(),
    )
    .unwrap();

    let page = read_session_transcript(&[("测试会话".to_owned(), session)], None, 50).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].kind, "compaction");
    assert_eq!(page.entries[0].blocks.len(), 1);
    match &page.entries[0].blocks[0] {
        SessionContentBlock::Compaction {
            reason,
            status,
            tokens_before,
            estimated_tokens_after,
            estimated_tokens_saved,
            first_kept_entry_id,
            from_hook,
            read_file_count,
            modified_file_count,
            will_retry,
            usage_known,
            ..
        } => {
            assert_eq!(reason, &None);
            assert_eq!(status, "completed");
            assert_eq!(*tokens_before, Some(12_000));
            assert_eq!(*estimated_tokens_after, None);
            assert_eq!(*estimated_tokens_saved, None);
            assert_eq!(first_kept_entry_id.as_deref(), Some("message-42"));
            assert!(!from_hook);
            assert_eq!(*read_file_count, 2);
            assert_eq!(*modified_file_count, 1);
            assert!(!will_retry);
            assert!(!usage_known);
        }
        block => panic!("expected compaction block, got {block:?}"),
    }
    assert!(!format!("{:?}", page.entries[0].blocks).contains("sensitive compacted context"));
    assert!(page.entries[0].raw.get("summary").is_none());
}

#[test]
fn parallel_review_session_accepts_camel_case_usage() {
    let blocks = parse_session_blocks(&serde_json::json!({
        "role": "toolResult",
        "toolCallId": "review-1",
        "toolName": "run_parallel_code_review",
        "content": [{"type": "text", "text": "done"}],
        "details": {
            "selection": {
                "classification": "source",
                "angles": ["正确性", "代码质量与测试"],
                "skippedAngles": ["边界与安全"],
                "reasons": ["普通源码"]
            },
            "reviews": [{
                "angle": "正确性",
                "transport_status": "completed",
                "error": null,
                "result": {
                    "findings": [{
                        "priority": "P2",
                        "category": "maintainability",
                        "path": "src/main.rs",
                        "location": "main",
                        "summary": "建议",
                        "evidence": "证据"
                    }]
                },
                "usage": {
                    "input": 11,
                    "output": 12,
                    "cacheRead": 13,
                    "cacheWrite": 14
                },
                "events": [
                    {"type": "tool_execution_start", "toolName": "read_staged_diff"},
                    {"type": "agent_end"}
                ]
            }]
        },
        "isError": false
    }));

    let SessionContentBlock::Subagents { reviews, selection } = &blocks[1] else {
        panic!("expected parsed subagents block");
    };
    let usage = reviews[0].usage.as_ref().unwrap();
    assert_eq!(usage.cache_read, 13);
    assert_eq!(usage.cache_write, 14);
    assert_eq!(reviews[0].events.len(), 2);
    assert_eq!(reviews[0].events[0]["toolName"], "read_staged_diff");
    assert_eq!(
        selection
            .as_ref()
            .and_then(|value| value.get("classification"))
            .and_then(serde_json::Value::as_str),
        Some("source")
    );
    assert_eq!(reviews[0].result.as_ref().unwrap().findings.len(), 1);
    let serialized = serde_json::to_value(usage).unwrap();
    assert_eq!(serialized["cacheRead"], 13);
    assert_eq!(serialized["cacheWrite"], 14);
}
