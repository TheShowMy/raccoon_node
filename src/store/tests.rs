#[allow(unused_imports)]
use super::*;
use std::time::{Duration, SystemTime};

use chrono::Utc;

use super::{
    JsonStore, RESTART_INTERRUPTION, is_retryable_execution_error, next_execution_recovery_stage,
    reject_reviewed_task, reset_review_for, runnable_task_indexes,
};

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
async fn current_database_repairs_missing_optional_columns() {
    let temp_dir = tempfile::tempdir().unwrap();
    let data_root = temp_dir.path().to_path_buf();
    drop(JsonStore::open(data_root.clone()).await.unwrap());
    let connection = rusqlite::Connection::open(data_root.join("data.db")).unwrap();
    connection
        .execute(
            "ALTER TABLE project_chats DROP COLUMN requirement_summary",
            [],
        )
        .unwrap();
    drop(connection);

    drop(JsonStore::open(data_root.clone()).await.unwrap());
    let connection = rusqlite::Connection::open(data_root.join("data.db")).unwrap();
    let has_column = connection
        .prepare("PRAGMA table_info(project_chats)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .any(|name| name.unwrap() == "requirement_summary");
    assert!(has_column);
}

#[tokio::test]
async fn version_two_database_migrates_to_version_three_without_data_loss() {
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
             ('req-v2', 'current', '保留需求', '迁移不能丢失', 'clarifying', '[]',
              0, '[]', 0, '[]', '2026-07-10T00:00:00Z',
              '2026-07-10T00:00:00Z', 'standalone');
             ALTER TABLE requirements DROP COLUMN origin;
             UPDATE schema_version SET version = 2;",
        )
        .unwrap();
    drop(connection);

    drop(JsonStore::open(data_root.clone()).await.unwrap());
    let connection = rusqlite::Connection::open(data_root.join("data.db")).unwrap();
    let version = connection
        .query_row("SELECT version FROM schema_version", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    let origin = connection
        .prepare("PRAGMA table_info(requirements)")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, Option<String>>(4)?))
        })
        .unwrap()
        .find_map(|column| {
            let (name, default) = column.unwrap();
            (name == "origin").then_some(default)
        })
        .expect("origin column must exist after migration");
    assert_eq!(version, 3);
    assert_eq!(origin.as_deref(), Some("'standalone'"));
    let original_message = connection
        .query_row(
            "SELECT original_message FROM requirements WHERE id = 'req-v2'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(original_message, "迁移不能丢失");
}
use crate::error::AppError;
use crate::models::{
    Project, ProjectChat, ProjectChatMessage, ProjectChatMessageRole, Requirement,
    RequirementDraft, RequirementExecutionPlan, RequirementExecutionTask, RequirementMessage,
    RequirementMessageRole, RequirementModelTier, RequirementRecoveryStage,
    RequirementReviewRoundStatus, RequirementReviewStatus, RequirementStatus,
    RequirementTaskExecutionOutput, RequirementTaskKind, RequirementTaskStatus,
};

#[test]
fn runnable_tasks_wait_without_error_while_dependencies_are_running() {
    let plan = RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![
            task(
                "task-a",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::Running,
            ),
            task_with_dependencies(
                "task-b",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::Pending,
                vec!["task-a"],
                None,
            ),
        ],
    };

    assert_eq!(runnable_task_indexes(&plan).unwrap(), Vec::<usize>::new());
}

#[test]
fn runnable_tasks_can_start_review_while_parallel_task_is_running() {
    let plan = RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![
            task(
                "fast-task",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::AwaitingReview,
            ),
            task(
                "slow-task",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::Running,
            ),
            task_with_dependencies(
                "review-fast",
                RequirementTaskKind::ReviewSubAgent,
                RequirementTaskStatus::Pending,
                vec!["fast-task"],
                Some("fast-task"),
            ),
        ],
    };

    assert_eq!(runnable_task_indexes(&plan).unwrap(), vec![2]);
}

#[tokio::test]
async fn fixing_task_keeps_execution_input_status_and_clears_stale_result() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join(".raccoon-node");
    let mut store = JsonStore::open(path.clone()).await.unwrap();
    let now = Utc::now();
    store.data.projects.push(Project {
        id: "project".to_owned(),
        name: "project".to_owned(),
        git_url: "https://example.com/project.git".to_owned(),
        local_path: temp_dir.path().to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
    });
    let mut fixing = task(
        "implementation",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Fixing,
    );
    fixing.result_summary = Some("旧结果".to_owned());
    fixing.execution_warning = Some("旧警告".to_owned());
    let mut active = requirement("requirement");
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![fixing],
    });
    store.data.requirements.push(active);

    let inputs = store
        .prepare_runnable_execution_tasks("requirement")
        .await
        .unwrap();

    assert_eq!(inputs[0].task.status, RequirementTaskStatus::Fixing);
    assert_eq!(
        store.data.requirements[0]
            .execution_plan
            .as_ref()
            .unwrap()
            .tasks[0]
            .status,
        RequirementTaskStatus::Running
    );
    assert!(inputs[0].task.result_summary.is_none());
    assert!(inputs[0].task.execution_warning.is_none());
    let reopened = JsonStore::open(path).await.unwrap();
    let persisted = &reopened.data.requirements[0]
        .execution_plan
        .as_ref()
        .unwrap()
        .tasks[0];
    assert_eq!(persisted.status, RequirementTaskStatus::Running);
    assert!(persisted.result_summary.is_none());
    assert!(persisted.execution_warning.is_none());
}

#[test]
fn reset_review_clears_previous_execution_state() {
    let mut review = task_with_dependencies(
        "review",
        RequirementTaskKind::ReviewSubAgent,
        RequirementTaskStatus::Rejected,
        vec!["implementation"],
        Some("implementation"),
    );
    review.review_status = RequirementReviewStatus::Rejected;
    review.pi_session_file = Some("session.jsonl".to_owned());
    review.last_review_feedback = Some("需要修复".to_owned());
    review.result_summary = Some("审核失败".to_owned());
    review.trace = Some(serde_json::json!({"step": "review"}));
    review.execution_warning = Some("warning".to_owned());
    review.error = Some("error".to_owned());
    let mut plan = RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![review],
    };

    reset_review_for(&mut plan, "implementation");

    let review = &plan.tasks[0];
    assert_eq!(review.status, RequirementTaskStatus::Pending);
    assert_eq!(review.review_status, RequirementReviewStatus::Pending);
    assert!(review.pi_session_file.is_none());
    assert!(review.last_review_feedback.is_none());
    assert!(review.result_summary.is_none());
    assert!(review.trace.is_none());
    assert!(review.execution_warning.is_none());
    assert!(review.error.is_none());
}

#[tokio::test]
async fn review_summary_uses_rejected_sub_agent_feedback() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let implementation = task(
        "implementation",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::AwaitingReview,
    );
    let mut sub_agent = task_with_dependencies(
        "sub-agent",
        RequirementTaskKind::ReviewSubAgent,
        RequirementTaskStatus::Rejected,
        vec!["implementation"],
        Some("implementation"),
    );
    sub_agent.review_status = RequirementReviewStatus::Rejected;
    sub_agent.last_review_feedback = Some("存在阻断问题".to_owned());
    let summary = task_with_dependencies(
        "summary",
        RequirementTaskKind::ReviewSummary,
        RequirementTaskStatus::Running,
        vec!["sub-agent"],
        Some("implementation"),
    );
    let mut active = requirement("requirement");
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![implementation, sub_agent, summary],
    });
    store.data.requirements.push(active);

    store
        .apply_task_execution_result(
            "requirement",
            "summary",
            Ok(RequirementTaskExecutionOutput {
                result_summary: "汇总完成".to_owned(),
                pi_session_file: None,
                branch_name: None,
                worktree_path: None,
                review_status: Some(RequirementReviewStatus::Approved),
                review_feedback: Some("全部通过".to_owned()),
                fix_instructions: None,
                pull_request_url: None,
                merged_into: None,
                cleanup_summary: None,
                execution_warning: None,
                changed: None,
                no_op_reason: None,
                recovery_guidance: None,
                trace: None,
            }),
        )
        .await
        .unwrap();

    let plan = store.data.requirements[0].execution_plan.as_ref().unwrap();
    assert_eq!(plan.tasks[2].status, RequirementTaskStatus::Rejected);
    assert_eq!(
        plan.tasks[2].last_review_feedback.as_deref(),
        Some("存在阻断问题")
    );
    assert_eq!(
        plan.tasks[2].result_summary.as_deref(),
        Some("审核不通过：存在阻断问题")
    );
    assert_eq!(plan.tasks[0].status, RequirementTaskStatus::Fixing);
    assert_eq!(
        plan.tasks[0].last_review_feedback.as_deref(),
        Some("存在阻断问题")
    );
}

#[tokio::test]
async fn successful_fix_clears_old_reviews_and_requeues_latest_review() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let implementation = task(
        "implementation",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::AwaitingReview,
    );
    let mut review = task_with_dependencies(
        "review",
        RequirementTaskKind::ReviewSubAgent,
        RequirementTaskStatus::Rejected,
        vec!["implementation"],
        Some("implementation"),
    );
    review.review_status = RequirementReviewStatus::Rejected;
    review.pi_session_file = Some("old-review.jsonl".to_owned());
    review.last_review_feedback = Some("旧审核反馈".to_owned());
    let summary = task_with_dependencies(
        "summary",
        RequirementTaskKind::ReviewSummary,
        RequirementTaskStatus::Rejected,
        vec!["review"],
        Some("implementation"),
    );
    let mut plan = RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![implementation, review, summary],
    };
    reject_reviewed_task(&mut plan, "summary", Some("补充边界校验".to_owned())).unwrap();
    let mut active = requirement("requirement");
    active.execution_plan = Some(plan);
    store.data.requirements.push(active);

    store
        .apply_task_execution_result(
            "requirement",
            "implementation",
            Ok(RequirementTaskExecutionOutput {
                result_summary: "已补充边界校验".to_owned(),
                pi_session_file: Some("implementation.jsonl".to_owned()),
                branch_name: None,
                worktree_path: None,
                review_status: None,
                review_feedback: None,
                fix_instructions: None,
                pull_request_url: None,
                merged_into: None,
                cleanup_summary: None,
                execution_warning: None,
                changed: Some(true),
                no_op_reason: None,
                recovery_guidance: None,
                trace: None,
            }),
        )
        .await
        .unwrap();

    let plan = store.data.requirements[0].execution_plan.as_ref().unwrap();
    assert_eq!(plan.tasks[0].status, RequirementTaskStatus::AwaitingReview);
    assert_eq!(
        plan.tasks[0].pi_session_file.as_deref(),
        Some("implementation.jsonl")
    );
    assert_eq!(plan.tasks[1].status, RequirementTaskStatus::Pending);
    assert!(plan.tasks[1].pi_session_file.is_none());
    assert!(plan.tasks[1].last_review_feedback.is_none());
    assert_eq!(runnable_task_indexes(plan).unwrap(), vec![1]);
}

#[tokio::test]
async fn review_history_persists_rejection_fix_and_approval_rounds() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join(".raccoon-node");
    let mut store = JsonStore::open(path.clone()).await.unwrap();
    let implementation = task(
        "implementation",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Running,
    );
    let mut review = task_with_dependencies(
        "review",
        RequirementTaskKind::ReviewSubAgent,
        RequirementTaskStatus::Pending,
        vec!["implementation"],
        Some("implementation"),
    );
    review.review_angle = Some("正确性".to_owned());
    let summary = task_with_dependencies(
        "summary",
        RequirementTaskKind::ReviewSummary,
        RequirementTaskStatus::Pending,
        vec!["review"],
        Some("implementation"),
    );
    let mut active = requirement("requirement");
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![implementation, review, summary],
    });
    store.data.requirements.push(active);

    store
        .apply_task_execution_result(
            "requirement",
            "implementation",
            Ok(task_output("首轮实现", None, None)),
        )
        .await
        .unwrap();
    store
        .apply_task_execution_result(
            "requirement",
            "review",
            Ok(task_output(
                "发现边界问题",
                Some(RequirementReviewStatus::Rejected),
                Some("缺少边界校验"),
            )),
        )
        .await
        .unwrap();
    store
        .apply_task_execution_result(
            "requirement",
            "summary",
            Ok(task_output(
                "汇总完成",
                Some(RequirementReviewStatus::Approved),
                Some("无其他问题"),
            )),
        )
        .await
        .unwrap();
    store
        .apply_task_execution_result(
            "requirement",
            "implementation",
            Ok(task_output("补充边界校验", None, None)),
        )
        .await
        .unwrap();
    store
        .apply_task_execution_result(
            "requirement",
            "review",
            Ok(task_output(
                "边界校验完整",
                Some(RequirementReviewStatus::Approved),
                None,
            )),
        )
        .await
        .unwrap();
    store
        .apply_task_execution_result(
            "requirement",
            "summary",
            Ok(task_output(
                "审核通过",
                Some(RequirementReviewStatus::Approved),
                None,
            )),
        )
        .await
        .unwrap();

    let reopened = JsonStore::open(path).await.unwrap();
    let implementation = &reopened.data.requirements[0]
        .execution_plan
        .as_ref()
        .unwrap()
        .tasks[0];
    assert_eq!(implementation.review_history.len(), 2);
    let rejected = &implementation.review_history[0];
    assert_eq!(rejected.round, 1);
    assert_eq!(rejected.implementation_attempt, 1);
    assert_eq!(rejected.status, RequirementReviewRoundStatus::Rejected);
    assert_eq!(rejected.reviews[0].angle, "正确性");
    assert_eq!(
        rejected.reviews[0].failure_reason.as_deref(),
        Some("缺少边界校验")
    );
    assert_eq!(rejected.failure_reason.as_deref(), Some("缺少边界校验"));
    assert!(rejected.completed_at.is_some());
    let approved = &implementation.review_history[1];
    assert_eq!(approved.round, 2);
    assert_eq!(approved.implementation_attempt, 2);
    assert_eq!(approved.status, RequirementReviewRoundStatus::Approved);
    assert_eq!(approved.summary.as_deref(), Some("审核通过"));
    assert!(approved.failure_reason.is_none());
}

#[test]
fn review_rejections_escalate_after_five_rounds() {
    let mut plan = RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![
            task(
                "implementation",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::AwaitingReview,
            ),
            task_with_dependencies(
                "summary",
                RequirementTaskKind::ReviewSummary,
                RequirementTaskStatus::Rejected,
                vec!["implementation"],
                Some("implementation"),
            ),
        ],
    };

    for count in 1..=7 {
        reject_reviewed_task(&mut plan, "summary", Some(format!("第 {count} 轮"))).unwrap();
        let implementation = &plan.tasks[0];
        assert_eq!(implementation.review_rejection_count, count);
        assert_eq!(
            implementation.recovery_stage,
            match count {
                1..=4 => RequirementRecoveryStage::None,
                5 => RequirementRecoveryStage::GuidedRetry,
                6 => RequirementRecoveryStage::HighTierExecution,
                _ => RequirementRecoveryStage::Exhausted,
            }
        );
    }
    assert_eq!(plan.tasks[0].status, RequirementTaskStatus::Failed);
}

#[test]
fn execution_failures_have_a_finite_escalation_path() {
    assert!(is_retryable_execution_error(&AppError::internal(
        "修复实现节点必须产生实际代码改动"
    )));
    assert!(is_retryable_execution_error(&AppError::internal(
        "等待 Pi Agent 新输出空闲超时"
    )));
    assert!(is_retryable_execution_error(&AppError::task_execution(
        "任务结果 JSON 解析失败，已尝试同会话修复",
        Some("session.jsonl".to_owned()),
    )));
    assert!(!is_retryable_execution_error(&AppError::internal(
        "恢复节点失败：worktree 不存在"
    )));
    assert_eq!(
        next_execution_recovery_stage(1, true),
        Some(RequirementRecoveryStage::AutoRetry)
    );
    assert_eq!(
        next_execution_recovery_stage(2, true),
        Some(RequirementRecoveryStage::AutoRetry)
    );
    assert_eq!(
        next_execution_recovery_stage(3, true),
        Some(RequirementRecoveryStage::GuidedRetry)
    );
    assert_eq!(
        next_execution_recovery_stage(4, true),
        Some(RequirementRecoveryStage::HighTierExecution)
    );
    assert_eq!(next_execution_recovery_stage(5, true), None);
    assert_eq!(next_execution_recovery_stage(1, false), None);
}

#[test]
fn execution_failure_keeps_the_infrastructure_error_detail() {
    let mut merge_review = task(
        "merge-review",
        RequirementTaskKind::MergeReview,
        RequirementTaskStatus::Running,
    );
    let error = AppError::from(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "无法读取最终审核工作区",
    ));
    let detail = error.to_string();

    register_execution_failure(
        &mut merge_review,
        &short_failure_summary(&error),
        &detail,
        false,
    );

    assert_eq!(
        merge_review.failure_summary.as_deref(),
        Some("I/O 错误：无法读取最终审核工作区")
    );
    assert_eq!(
        merge_review.error.as_deref(),
        merge_review.failure_summary.as_deref()
    );
}

#[tokio::test]
async fn final_failure_keeps_parallel_branch_running_until_all_progress_stops() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let mut active = requirement("requirement");
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![
            task(
                "task-a",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::Running,
            ),
            task(
                "task-b",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::Running,
            ),
        ],
    });
    store.data.requirements.push(active);

    let first = store
        .apply_task_execution_result(
            "requirement",
            "task-a",
            Err(AppError::bad_request("不可重试")),
        )
        .await
        .unwrap();
    assert_eq!(first, TaskExecutionDisposition::FinalFailure);
    assert_eq!(
        store.data.requirements[0].status,
        RequirementStatus::Running
    );

    let second = store
        .apply_task_execution_result(
            "requirement",
            "task-b",
            Err(AppError::bad_request("不可重试")),
        )
        .await
        .unwrap();
    assert_eq!(second, TaskExecutionDisposition::FinalFailure);
    assert_eq!(store.data.requirements[0].status, RequirementStatus::Failed);
}

#[tokio::test]
async fn failed_implementation_groups_recover_independently_and_keep_resources() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let mut implementation_a = task(
        "task-a",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Failed,
    );
    implementation_a.pi_session_file = Some("task-a.jsonl".to_owned());
    implementation_a.worktree_path = Some("/tmp/task-a".to_owned());
    implementation_a.branch_name = Some("task-a".to_owned());
    let review_a = task_with_dependencies(
        "review-a",
        RequirementTaskKind::ReviewSubAgent,
        RequirementTaskStatus::Completed,
        vec!["task-a"],
        Some("task-a"),
    );
    let implementation_b = task(
        "task-b",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Failed,
    );
    let mut failed = requirement("requirement");
    failed.status = RequirementStatus::Failed;
    failed.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![
            implementation_a,
            review_a,
            implementation_b,
            task_with_dependencies(
                "downstream",
                RequirementTaskKind::BranchMerge,
                RequirementTaskStatus::Completed,
                vec!["task-a"],
                None,
            ),
        ],
    });
    store.data.requirements.push(failed);

    store
        .recover_task_group("requirement", "task-a")
        .await
        .unwrap();
    let plan = store.data.requirements[0].execution_plan.as_ref().unwrap();
    assert_eq!(plan.tasks[0].status, RequirementTaskStatus::Fixing);
    assert_eq!(plan.tasks[1].status, RequirementTaskStatus::Pending);
    assert_eq!(plan.tasks[2].status, RequirementTaskStatus::Failed);
    assert_eq!(plan.tasks[3].status, RequirementTaskStatus::Completed);
    assert_eq!(
        plan.tasks[0].pi_session_file.as_deref(),
        Some("task-a.jsonl")
    );
    assert_eq!(plan.tasks[0].worktree_path.as_deref(), Some("/tmp/task-a"));
    assert_eq!(plan.tasks[0].branch_name.as_deref(), Some("task-a"));

    store
        .recover_task_group("requirement", "task-b")
        .await
        .unwrap();
    let plan = store.data.requirements[0].execution_plan.as_ref().unwrap();
    assert_eq!(plan.tasks[0].status, RequirementTaskStatus::Fixing);
    assert_eq!(plan.tasks[2].status, RequirementTaskStatus::Fixing);
}

#[tokio::test]
async fn recovering_failed_reviews_keeps_successes_and_resets_summary_for_sub_agent() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let implementation = task(
        "implementation",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::AwaitingReview,
    );
    let successful_review = task_with_dependencies(
        "successful-review",
        RequirementTaskKind::ReviewSubAgent,
        RequirementTaskStatus::Completed,
        vec!["implementation"],
        Some("implementation"),
    );
    let failed_review = task_with_dependencies(
        "failed-review",
        RequirementTaskKind::ReviewSubAgent,
        RequirementTaskStatus::Failed,
        vec!["implementation"],
        Some("implementation"),
    );
    let summary = task_with_dependencies(
        "summary",
        RequirementTaskKind::ReviewSummary,
        RequirementTaskStatus::Completed,
        vec!["successful-review", "failed-review"],
        Some("implementation"),
    );
    let mut failed = requirement("requirement");
    failed.status = RequirementStatus::Failed;
    failed.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![implementation, successful_review, failed_review, summary],
    });
    store.data.requirements.push(failed);

    store
        .recover_task_group("requirement", "implementation")
        .await
        .unwrap();
    let plan = store.data.requirements[0].execution_plan.as_ref().unwrap();
    assert_eq!(plan.tasks[0].status, RequirementTaskStatus::AwaitingReview);
    assert_eq!(plan.tasks[1].status, RequirementTaskStatus::Completed);
    assert_eq!(plan.tasks[2].status, RequirementTaskStatus::Pending);
    assert_eq!(plan.tasks[3].status, RequirementTaskStatus::Pending);
}

#[tokio::test]
async fn rejected_reviews_are_not_manually_recoverable() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let implementation = task(
        "implementation",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Fixing,
    );
    let rejected_review = task_with_dependencies(
        "review",
        RequirementTaskKind::Review,
        RequirementTaskStatus::Rejected,
        vec!["implementation"],
        Some("implementation"),
    );
    let mut active = requirement("requirement");
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![implementation, rejected_review],
    });
    store.data.requirements.push(active);

    let error = store
        .recover_task_group("requirement", "implementation")
        .await
        .unwrap_err();

    assert!(error.to_string().contains("没有失败节点"));
}

#[tokio::test]
async fn merge_nodes_can_recover_while_another_group_is_running() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let mut active = requirement("requirement");
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![
            task(
                "implementation",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::Running,
            ),
            task(
                "branch-merge",
                RequirementTaskKind::BranchMerge,
                RequirementTaskStatus::Failed,
            ),
            task(
                "merge-review",
                RequirementTaskKind::MergeReview,
                RequirementTaskStatus::Failed,
            ),
        ],
    });
    store.data.requirements.push(active);

    store
        .recover_task_group("requirement", "branch-merge")
        .await
        .unwrap();
    store
        .recover_task_group("requirement", "merge-review")
        .await
        .unwrap();

    let plan = store.data.requirements[0].execution_plan.as_ref().unwrap();
    assert_eq!(plan.tasks[0].status, RequirementTaskStatus::Running);
    assert_eq!(plan.tasks[1].status, RequirementTaskStatus::Pending);
    assert_eq!(plan.tasks[2].status, RequirementTaskStatus::Pending);
}

#[tokio::test]
async fn startup_recovery_persists_interrupted_tasks_and_returns_all_running_requirements() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join(".raccoon-node");
    let mut store = JsonStore::open(path.clone()).await.unwrap();
    let mut interrupted = requirement("interrupted");
    interrupted.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![
            task(
                "implementation",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::Running,
            ),
            task(
                "merge",
                RequirementTaskKind::BranchMerge,
                RequirementTaskStatus::Running,
            ),
        ],
    });
    let mut waiting = requirement("waiting");
    waiting.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![task(
            "pending",
            RequirementTaskKind::Implementation,
            RequirementTaskStatus::Pending,
        )],
    });
    let mut planning = requirement("planning");
    planning.status = RequirementStatus::Planning;
    planning.execution_plan = None;
    store.data.requirements = vec![interrupted, waiting, planning];
    store.persist().await.unwrap();

    let requirement_ids = store.recover_interrupted_requirements().await.unwrap();

    assert_eq!(requirement_ids, vec!["project"]);
    let task = &store.data.requirements[0]
        .execution_plan
        .as_ref()
        .unwrap()
        .tasks[0];
    assert_eq!(task.status, RequirementTaskStatus::Fixing);
    assert_eq!(task.execution_failure_count, 1);
    assert_eq!(task.recovery_stage, RequirementRecoveryStage::AutoRetry);
    assert_eq!(task.failure_summary.as_deref(), Some(RESTART_INTERRUPTION));
    assert_eq!(task.error.as_deref(), Some(RESTART_INTERRUPTION));
    assert_eq!(
        store.data.requirements[0]
            .execution_plan
            .as_ref()
            .unwrap()
            .tasks[1]
            .status,
        RequirementTaskStatus::Pending
    );
    let planning_requirement = store
        .data
        .requirements
        .iter()
        .find(|requirement| requirement.id == "planning")
        .expect("planning requirement exists");
    assert_eq!(planning_requirement.status, RequirementStatus::Queued);
    assert!(planning_requirement.error.is_none());
    assert!(planning_requirement.queued_at.is_some());

    let reopened = JsonStore::open(path).await.unwrap();
    assert_eq!(
        reopened.data.requirements[0]
            .execution_plan
            .as_ref()
            .unwrap()
            .tasks[0]
            .status,
        RequirementTaskStatus::Fixing
    );
    let reopened_planning = reopened
        .data
        .requirements
        .iter()
        .find(|requirement| requirement.id == "planning")
        .expect("planning requirement exists");
    assert_eq!(reopened_planning.status, RequirementStatus::Queued);
}

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
async fn stale_pi_session_cleanup_keeps_requirement_and_task_references() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let session_dir = store.data_root.join("sessions");
    tokio::fs::create_dir_all(&session_dir).await.unwrap();
    let requirement_session = session_dir.join("requirement.jsonl");
    let project_chat_session = session_dir.join("project-chat.jsonl");
    let task_session = session_dir.join("task.jsonl");
    let stale_session = session_dir.join("stale.jsonl");
    let ignored_file = session_dir.join("ignored.txt");
    for path in [
        &requirement_session,
        &project_chat_session,
        &task_session,
        &stale_session,
        &ignored_file,
    ] {
        tokio::fs::write(path, b"session").await.unwrap();
    }

    let mut active = requirement("active");
    active.pi_session_file = Some(requirement_session.to_string_lossy().to_string());
    let mut active_task = task(
        "task",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Pending,
    );
    active_task.pi_session_file = Some(task_session.to_string_lossy().to_string());
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![active_task],
    });
    store.data.requirements.push(active);
    let now = Utc::now();
    store.data.project_chats.push(ProjectChat {
        project_id: "project".to_owned(),
        messages: Vec::new(),
        running: false,
        error: None,
        pi_session_file: Some(project_chat_session.to_string_lossy().to_string()),
        created_at: now,
        updated_at: now,
    });

    store
        .cleanup_unreferenced_pi_sessions_before(SystemTime::now() + Duration::from_secs(60))
        .await;

    assert!(requirement_session.exists());
    assert!(project_chat_session.exists());
    assert!(task_session.exists());
    assert!(!stale_session.exists());
    assert!(ignored_file.exists());
}

#[tokio::test]
async fn requirement_task_session_parses_messages() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let session_dir = store.data_root.join("sessions");
    tokio::fs::create_dir_all(&session_dir).await.unwrap();
    let session_file = session_dir.join("task.jsonl");
    tokio::fs::write(
        &session_file,
        r#"{"type":"session","id":"s1","timestamp":"2026-07-01T00:00:00Z"}
{"type":"message","id":"m1","timestamp":"2026-07-01T00:01:00Z","message":{"role":"system","content":[{"type":"text","text":"system prompt"}]}}
{"type":"message","id":"m2","timestamp":"2026-07-01T00:02:00Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}
{"type":"message","id":"m3","timestamp":"2026-07-01T00:03:00Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"thinking text"},{"type":"text","text":"reply"},{"type":"toolCall","id":"edit-1","name":"edit","arguments":{"path":"file.txt","edits":[{"oldText":"old","newText":"new"}]}}]}}
{"type":"message","id":"m4","timestamp":"2026-07-01T00:04:00Z","message":{"role":"toolResult","toolCallId":"edit-1","toolName":"edit","content":[{"type":"text","text":"Successfully replaced 1 block in file.txt."},{"type":"image","data":"preview"}],"details":{"diff":"@@ -1 +1 @@\n-old\n+new"},"isError":false}}
{"type":"not_a_message","id":"n1"}
not valid json
"#,
    )
    .await
    .unwrap();

    let mut active_task = task(
        "task-1",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Completed,
    );
    active_task.pi_session_file = Some(session_file.to_string_lossy().to_string());
    let mut active = requirement("req-1");
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![active_task],
    });
    store.data.requirements.push(active);

    let session = store
        .requirement_task_session("req-1", "task-1", None, 100)
        .unwrap();
    assert_eq!(session.entries.len(), 6);
    assert_eq!(session.invalid_lines, 1);
    assert!(session.entries.iter().any(|entry| entry.kind == "session"));
    let system = session
        .entries
        .iter()
        .find(|entry| entry.role.as_deref() == Some("system"))
        .unwrap();
    assert!(matches!(
        &system.blocks[0],
        SessionContentBlock::Text { text } if text == "system prompt"
    ));
    let user = session
        .entries
        .iter()
        .find(|entry| entry.role.as_deref() == Some("user"))
        .unwrap();
    assert!(matches!(
        &user.blocks[0],
        SessionContentBlock::Text { text } if text == "hello"
    ));
    let assistant = session
        .entries
        .iter()
        .find(|entry| entry.role.as_deref() == Some("assistant"))
        .unwrap();
    assert!(matches!(
        &assistant.blocks[0],
        SessionContentBlock::Thinking { text } if text == "thinking text"
    ));
    assert!(matches!(
        &assistant.blocks[1],
        SessionContentBlock::Text { text } if text == "reply"
    ));
    assert!(matches!(
        &assistant.blocks[2],
        SessionContentBlock::ToolCall { id, name, arguments }
            if id == "edit-1" && name == "edit" && arguments["path"] == "file.txt"
    ));
    let tool_result = session
        .entries
        .iter()
        .find(|entry| entry.role.as_deref() == Some("toolResult"))
        .unwrap();
    assert!(matches!(
        &tool_result.blocks[0],
        SessionContentBlock::ToolResult {
            tool_call_id,
            output,
            diff,
            is_error,
            ..
        } if tool_call_id == "edit-1"
            && output.contains("Successfully replaced")
            && diff.as_deref() == Some("@@ -1 +1 @@\n-old\n+new")
            && !is_error
    ));
    assert!(matches!(
        &tool_result.blocks[1],
        SessionContentBlock::Unknown { block_type, .. } if block_type == "image"
    ));

    let page = store
        .requirement_task_session("req-1", "task-1", None, 3)
        .unwrap();
    assert_eq!(page.entries.len(), 3);
    assert_eq!(page.next_before, Some(3));
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
async fn requirement_task_session_rejects_missing_and_escaping_paths() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let session_dir = store.data_root.join("sessions");
    tokio::fs::create_dir_all(&session_dir).await.unwrap();

    let mut active_task = task(
        "task-1",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Completed,
    );
    active_task.pi_session_file = Some("../etc/passwd".to_owned());
    let mut active = requirement("req-1");
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![active_task],
    });
    store.data.requirements.push(active);

    let error = store
        .requirement_task_session("req-1", "task-1", None, 100)
        .unwrap_err()
        .to_string();
    assert!(error.contains("路径必须位于数据目录内"));
}

#[tokio::test]
async fn requirement_task_session_returns_not_found_when_file_missing() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join(".raccoon-node"))
        .await
        .unwrap();
    let session_dir = store.data_root.join("sessions");
    tokio::fs::create_dir_all(&session_dir).await.unwrap();

    let mut active_task = task(
        "task-1",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Completed,
    );
    active_task.pi_session_file = Some("missing.jsonl".to_owned());
    let mut active = requirement("req-1");
    active.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "plan".to_owned(),
        tasks: vec![active_task],
    });
    store.data.requirements.push(active);

    let error = store
        .requirement_task_session("req-1", "task-1", None, 100)
        .unwrap_err()
        .to_string();
    assert!(error.contains("不存在"));
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
        execution_plan: None,
        pi_session_file: None,
        error: None,
        queued_at: None,
        created_at: now,
        updated_at: now,
    }
}

#[tokio::test]
async fn task_detail_preserves_diagnostics_but_hides_internal_paths() {
    let mut requirement = requirement("req-detail");
    let mut detail = task(
        "task-detail",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Failed,
    );
    detail.pi_session_file = Some("/private/session.jsonl".to_owned());
    detail.worktree_path = Some("/private/worktree".to_owned());
    detail.failure_summary = Some("tests failed".to_owned());
    detail.recovery_guidance = Some("retry after fixing".to_owned());
    detail.pull_request_url = Some("https://example.test/pr/1".to_owned());
    detail.target_files = vec!["src/lib.rs".to_owned()];
    detail.trace = Some(serde_json::json!({"trace": {"usage": {"input": 1}}}));
    requirement.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "detail".to_owned(),
        tasks: vec![detail],
    });
    let temp = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp.path().join(".raccoon-node"))
        .await
        .unwrap();
    store.data.requirements.push(requirement);

    let response = store
        .requirement_task_detail("req-detail", "task-detail")
        .unwrap();
    assert!(response.task.pi_session_file.is_none());
    assert!(response.task.worktree_path.is_none());
    assert_eq!(
        response.task.failure_summary.as_deref(),
        Some("tests failed")
    );
    assert_eq!(
        response.task.recovery_guidance.as_deref(),
        Some("retry after fixing")
    );
    assert_eq!(response.task.target_files, vec!["src/lib.rs"]);
    assert!(response.task.trace.is_some());
}

fn queued_requirement(id: &str, queued_at: chrono::DateTime<Utc>) -> Requirement {
    let mut requirement = requirement(id);
    requirement.status = RequirementStatus::Queued;
    requirement.draft = Some(RequirementDraft {
        title: id.to_owned(),
        summary: id.to_owned(),
        acceptance_criteria: vec!["完成".to_owned()],
    });
    requirement.queued_at = Some(queued_at);
    requirement
}

fn task(
    id: &str,
    kind: RequirementTaskKind,
    status: RequirementTaskStatus,
) -> RequirementExecutionTask {
    task_with_dependencies(id, kind, status, Vec::new(), None)
}

fn task_with_dependencies(
    id: &str,
    kind: RequirementTaskKind,
    status: RequirementTaskStatus,
    depends_on: Vec<&str>,
    review_for: Option<&str>,
) -> RequirementExecutionTask {
    RequirementExecutionTask {
        id: id.to_owned(),
        title: id.to_owned(),
        description: id.to_owned(),
        depends_on: depends_on.into_iter().map(str::to_owned).collect(),
        kind,
        model_tier: RequirementModelTier::Medium,
        timeout_seconds: 60,
        pi_session_file: None,
        branch_name: None,
        worktree_path: None,
        review_for: review_for.map(str::to_owned),
        review_angle: None,
        review_status: RequirementReviewStatus::Pending,
        review_history: Vec::new(),
        attempt: 0,
        execution_failure_count: 0,
        review_rejection_count: 0,
        recovery_stage: RequirementRecoveryStage::None,
        failure_summary: None,
        recovery_guidance: None,
        high_tier_execution_used: false,
        last_review_feedback: None,
        last_review_fix_instructions: None,
        pull_request_url: None,
        merged_into: None,
        cleanup_summary: None,
        execution_warning: None,
        trace: None,
        status,
        target_files: Vec::new(),
        result_summary: None,
        error: None,
    }
}

fn task_output(
    result_summary: &str,
    review_status: Option<RequirementReviewStatus>,
    review_feedback: Option<&str>,
) -> RequirementTaskExecutionOutput {
    RequirementTaskExecutionOutput {
        result_summary: result_summary.to_owned(),
        pi_session_file: None,
        branch_name: None,
        worktree_path: None,
        review_status,
        review_feedback: review_feedback.map(str::to_owned),
        fix_instructions: None,
        pull_request_url: None,
        merged_into: None,
        cleanup_summary: None,
        execution_warning: None,
        changed: None,
        no_op_reason: None,
        recovery_guidance: None,
        trace: None,
    }
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

fn trace_message(content: &str, usage: serde_json::Value) -> RequirementMessage {
    let now = Utc::now();
    RequirementMessage {
        role: RequirementMessageRole::Trace,
        content: content.to_owned(),
        references: Vec::new(),
        images: Vec::new(),
        metadata: Some(serde_json::json!({
            "type": "pi_trace",
            "version": 1,
            "trace": { "usage": usage }
        })),
        created_at: now,
    }
}

#[test]
fn aggregate_token_usage_classifies_chat_split_and_task() {
    let mut chat_req = requirement("chat");
    chat_req.messages.clear();

    let chat = project_chat_with_usage(
        "project",
        serde_json::json!({
            "input": 1,
            "output": 2,
            "cacheRead": 3,
            "cacheWrite": 4,
        }),
    );

    let mut split_req = requirement("split");
    split_req.messages = vec![
        trace_message(
            "Pi Agent 分析过程",
            serde_json::json!({
                "input": 5,
                "output": 6,
                "cacheRead": 7,
                "cacheWrite": 8,
            }),
        ),
        trace_message(
            "执行计划生成过程",
            serde_json::json!({
                "input": 9,
                "output": 10,
                "cacheRead": 11,
                "cacheWrite": 12,
            }),
        ),
    ];

    let mut task_req = requirement("task");
    let mut task = task(
        "task-usage",
        RequirementTaskKind::Implementation,
        RequirementTaskStatus::Completed,
    );
    task.trace = Some(serde_json::json!({
        "type": "pi_trace",
        "version": 1,
        "trace": {
            "usage": {
                "input": 13,
                "output": 14,
                "cacheRead": 15,
                "cacheWrite": 16,
            }
        }
    }));
    task_req.execution_plan = Some(RequirementExecutionPlan {
        trace: None,
        summary: "task-plan".to_owned(),
        tasks: vec![task],
    });

    let usage = aggregate_project_token_usage(
        vec![&chat].into_iter(),
        vec![&split_req, &task_req].into_iter(),
    )
    .unwrap();

    assert_eq!(usage.chat.input, 1);
    assert_eq!(usage.chat.output, 2);
    assert_eq!(usage.chat.cache_read, 3);
    assert_eq!(usage.chat.cache_write, 4);

    assert_eq!(usage.split.input, 5 + 9);
    assert_eq!(usage.split.output, 6 + 10);
    assert_eq!(usage.split.cache_read, 7 + 11);
    assert_eq!(usage.split.cache_write, 8 + 12);

    assert_eq!(usage.task.input, 13);
    assert_eq!(usage.task.output, 14);
    assert_eq!(usage.task.cache_read, 15);
    assert_eq!(usage.task.cache_write, 16);

    assert_eq!(
        usage.total.input,
        usage.chat.input + usage.split.input + usage.task.input
    );
    assert_eq!(
        usage.total.output,
        usage.chat.output + usage.split.output + usage.task.output
    );
    assert_eq!(
        usage.total.cache_read,
        usage.chat.cache_read + usage.split.cache_read + usage.task.cache_read
    );
    assert_eq!(
        usage.total.cache_write,
        usage.chat.cache_write + usage.split.cache_write + usage.task.cache_write
    );
}

#[test]
fn aggregate_token_usage_includes_planning_trace_in_split() {
    let mut req = requirement("plan-trace");
    req.execution_plan = Some(RequirementExecutionPlan {
        trace: Some(serde_json::json!({
            "type": "pi_trace",
            "version": 1,
            "trace": {
                "usage": {
                    "input": 10,
                    "output": 20,
                    "cacheRead": 30,
                    "cacheWrite": 40,
                }
            }
        })),
        summary: "plan".to_owned(),
        tasks: vec![],
    });

    let usage = aggregate_project_token_usage(std::iter::empty(), vec![&req].into_iter()).unwrap();

    assert_eq!(usage.split.input, 10);
    assert_eq!(usage.split.output, 20);
    assert_eq!(usage.split.cache_read, 30);
    assert_eq!(usage.split.cache_write, 40);
    assert_eq!(usage.total.input, 10);
}
