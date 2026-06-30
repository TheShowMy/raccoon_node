#[allow(unused_imports)]
use super::*;
use std::time::{Duration, SystemTime};

use chrono::Utc;

use super::{
    is_retryable_execution_error, next_execution_recovery_stage, reject_reviewed_task,
    reset_review_for, runnable_task_indexes, JsonStore, RESTART_INTERRUPTION,
};
use crate::error::AppError;
use crate::models::{
    Project, ProjectChatMessage, ProjectChatMessageRole, Requirement, RequirementDraft,
    RequirementExecutionPlan, RequirementExecutionTask, RequirementMessage, RequirementMessageRole,
    RequirementModelTier, RequirementRecoveryStage, RequirementReviewStatus, RequirementStatus,
    RequirementTaskExecutionOutput, RequirementTaskKind, RequirementTaskStatus,
};

#[test]
fn runnable_tasks_wait_without_error_while_dependencies_are_running() {
    let plan = RequirementExecutionPlan {
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
    let path = temp_dir.path().join("data/app.json");
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
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
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
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
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

#[test]
fn review_rejections_escalate_after_five_rounds() {
    let mut plan = RequirementExecutionPlan {
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

#[tokio::test]
async fn final_failure_keeps_parallel_branch_running_until_all_progress_stops() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
        .await
        .unwrap();
    let mut active = requirement("requirement");
    active.execution_plan = Some(RequirementExecutionPlan {
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
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
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
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
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
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
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
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
        .await
        .unwrap();
    let mut active = requirement("requirement");
    active.execution_plan = Some(RequirementExecutionPlan {
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
    let path = temp_dir.path().join("data/app.json");
    let mut store = JsonStore::open(path.clone()).await.unwrap();
    let mut interrupted = requirement("interrupted");
    interrupted.execution_plan = Some(RequirementExecutionPlan {
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
    crate::utils::write_json(&store.path, &store.data)
        .await
        .unwrap();

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
    assert_eq!(store.data.requirements[2].status, RequirementStatus::Queued);
    assert!(store.data.requirements[2].error.is_none());
    assert!(store.data.requirements[2].queued_at.is_some());

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
    assert_eq!(
        reopened.data.requirements[2].status,
        RequirementStatus::Queued
    );
}

#[tokio::test]
async fn project_scheduler_claims_confirmed_requirements_in_fifo_order() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
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
        .as_ref()
        .unwrap()
        .load_requirements()
        .unwrap()
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
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
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

    assert!(store
        .prepare_next_project_action("project")
        .await
        .unwrap()
        .is_none());
    assert_eq!(store.data.requirements[1].status, RequirementStatus::Queued);
}

#[tokio::test]
async fn running_requirement_only_blocks_its_own_project() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
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
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
        .await
        .unwrap();
    let session_dir = store.data_root.join("sessions");
    tokio::fs::create_dir_all(&session_dir).await.unwrap();
    let requirement_session = session_dir.join("requirement.jsonl");
    let task_session = session_dir.join("task.jsonl");
    let stale_session = session_dir.join("stale.jsonl");
    let ignored_file = session_dir.join("ignored.txt");
    for path in [
        &requirement_session,
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
        summary: "plan".to_owned(),
        tasks: vec![active_task],
    });
    store.data.requirements.push(active);

    store
        .cleanup_unreferenced_pi_sessions_before(SystemTime::now() + Duration::from_secs(60))
        .await;

    assert!(requirement_session.exists());
    assert!(task_session.exists());
    assert!(!stale_session.exists());
    assert!(ignored_file.exists());
}

#[tokio::test]
async fn project_store_uses_flat_data_directories_and_current_project() {
    let temp_dir = tempfile::tempdir().unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(temp_dir.path())
        .status()
        .unwrap()
        .success());
    let data_root = temp_dir.path().join(".raccoon-node");
    let store = JsonStore::open_project(data_root.join("app.json"), temp_dir.path().to_path_buf())
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
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(project.path())
        .status()
        .unwrap()
        .success());
    std::os::unix::fs::symlink(outside.path(), project.path().join(".raccoon-node")).unwrap();

    assert!(JsonStore::open_project(
        project.path().join(".raccoon-node/app.json"),
        project.path().to_path_buf(),
    )
    .await
    .is_err());
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn resetting_project_chat_clears_context_and_rejects_running_chat() {
    let temp_dir = tempfile::tempdir().unwrap();
    let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
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

fn requirement(id: &str) -> Requirement {
    let now = Utc::now();
    Requirement {
        id: id.to_owned(),
        project_id: "project".to_owned(),
        title: id.to_owned(),
        original_message: id.to_owned(),
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
        execution_plan: None,
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
        attempt: 0,
        execution_failure_count: 0,
        review_rejection_count: 0,
        recovery_stage: RequirementRecoveryStage::None,
        failure_summary: None,
        recovery_guidance: None,
        high_tier_execution_used: false,
        last_review_feedback: None,
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
