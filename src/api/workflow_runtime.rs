use std::{collections::BTreeMap, path::Path, time::Duration as StdDuration};

use chrono::Utc;

use crate::api::AppState;
use crate::error::AppError;
use crate::models::{RequirementEventEmitter, RequirementModelTier, RequirementStatus};
use crate::workflow::{
    CheckpointKind, CheckpointStatus, FailureClass, FindingStatus, ItemGitWorkspace,
    PausedOperation, RemoteReviewState, RepositoryValidationCatalog, ReviewAngle, ReviewReport,
    ReviewTransportStatus, ValidationRunStatus, ValidationSource, WorkflowAgentInput,
    WorkflowAttemptKind, WorkflowAttemptStatus, WorkflowCleanupStatus, WorkflowItemWorkspace,
    WorkflowItemWorkspaceStatus, WorkflowLocalSyncStatus, WorkflowPublicationMode,
    WorkflowPublicationPhase, WorkflowReviewInput, WorkflowRunStatus, WorkflowSnapshot,
    WorkflowValidation, all_work_items_accepted, arm_remote_auto_merge, cherry_pick_item_commit,
    clean_integration_fingerprint, cleanup_item_workspace, cleanup_workflow_workspace,
    commit_changed_paths, commit_integration_checkpoint, commit_item_workspace,
    delete_remote_workflow_branch, discover_publication, execute_catalog_command,
    integrate_workflow_branch, latest_open_blockers, new_workflow_id, next_attempt_policy,
    open_remote_review, prepare_integration_workspace, prepare_item_workspace,
    push_workflow_branch, remote_review_state, required_review_angles_for_diff,
    stage_integration_changes, staged_integration_diff, sync_local_target_branch,
    worktree_fingerprint,
};

pub struct RunDriver {
    state: AppState,
    requirement_id: String,
    run_id: String,
}

impl RunDriver {
    pub fn new(state: AppState, requirement_id: String, run_id: String) -> Self {
        Self {
            state,
            requirement_id,
            run_id,
        }
    }

    pub async fn drive(self) -> RequirementStatus {
        drive_workflow_run(self.state, self.requirement_id, self.run_id).await
    }
}

pub async fn run_workflow_execution(
    state: AppState,
    requirement_id: String,
    run_id: String,
) -> RequirementStatus {
    RunDriver::new(state, requirement_id, run_id).drive().await
}

async fn drive_workflow_run(
    state: AppState,
    requirement_id: String,
    run_id: String,
) -> RequirementStatus {
    let emitter = RequirementEventEmitter {
        requirement_id: requirement_id.clone(),
        task_id: None,
        bus: state.requirement_events.clone(),
    };
    emitter.emit("workflow_started", "WorkflowRun 开始执行行为切片。");

    let (project, model_settings, data_root) = {
        let store = state.store.read().await;
        let model_settings = match store.model_settings() {
            Ok(settings) => settings,
            Err(error) => {
                drop(store);
                return pause_and_sync(
                    &state,
                    &requirement_id,
                    &run_id,
                    PausedOperation::LoadSnapshot.as_str(),
                    &error.to_string(),
                    &emitter,
                )
                .await;
            }
        };
        (
            state.project.metadata.clone(),
            model_settings,
            store.data_root.clone(),
        )
    };

    let cleanup_workspace = {
        let store = state.store.read().await;
        store
            .db
            .workflow_snapshot(&run_id)
            .ok()
            .and_then(|snapshot| {
                snapshot
                    .publication
                    .as_ref()
                    .is_some_and(|publication| {
                        matches!(
                            publication.phase,
                            WorkflowPublicationPhase::Merged
                                | WorkflowPublicationPhase::Cleaning
                                | WorkflowPublicationPhase::Completed
                        )
                    })
                    .then(|| workspace_from_snapshot(&project.local_path, &snapshot))
            })
    };
    let workspace = match cleanup_workspace.transpose() {
        Ok(Some(workspace)) => workspace,
        Err(error) => {
            return pause_and_sync(
                &state,
                &requirement_id,
                &run_id,
                "restore_publication_workspace",
                &error.to_string(),
                &emitter,
            )
            .await;
        }
        Ok(None) => {
            match prepare_integration_workspace(&data_root, &project.local_path, &run_id).await {
                Ok(workspace) => workspace,
                Err(error) => {
                    return pause_and_sync(
                        &state,
                        &requirement_id,
                        &run_id,
                        "prepare_workspace",
                        &error.to_string(),
                        &emitter,
                    )
                    .await;
                }
            }
        }
    };
    if let Err(error) = attach_workspace(&state, &run_id, &workspace).await {
        return pause_and_sync(
            &state,
            &requirement_id,
            &run_id,
            "attach_workspace",
            &error.to_string(),
            &emitter,
        )
        .await;
    }
    let existing_publication = {
        let store = state.store.read().await;
        store
            .db
            .workflow_snapshot(&run_id)
            .ok()
            .and_then(|snapshot| snapshot.publication)
    };
    let commit_mode = state.config.read().await.commit_mode;
    let mut publication = match existing_publication {
        Some(publication) => publication,
        None => match discover_publication(&workspace, commit_mode).await {
            Ok(publication) => publication,
            Err(error) => {
                return pause_and_sync(
                    &state,
                    &requirement_id,
                    &run_id,
                    "freeze_publication",
                    &error.to_string(),
                    &emitter,
                )
                .await;
            }
        },
    };
    publication.run_id.clone_from(&run_id);
    let frozen = {
        let store = state.store.read().await;
        store.db.ensure_workflow_publication(&publication)
    };
    if let Err(error) = frozen {
        return pause_and_sync(
            &state,
            &requirement_id,
            &run_id,
            "freeze_publication",
            &error.to_string(),
            &emitter,
        )
        .await;
    }
    let publication_resume = {
        let store = state.store.read().await;
        store.db.workflow_snapshot(&run_id).ok()
    };
    if let Some(snapshot) = publication_resume
        && snapshot.run.paused_operation != Some(PausedOperation::RemoteCiFix)
        && let (Some(publication), Some(checkpoint)) = (
            snapshot.publication.as_ref(),
            snapshot
                .checkpoints
                .iter()
                .rev()
                .find(|checkpoint| checkpoint.status == CheckpointStatus::Approved),
        )
        && (publication.phase != WorkflowPublicationPhase::Prepared
            || snapshot.run.status == WorkflowRunStatus::Publishing
            || snapshot
                .run
                .paused_operation
                .is_some_and(is_publication_resume_operation))
    {
        return publish_approved_workflow(
            &state,
            &requirement_id,
            &run_id,
            &workspace,
            &checkpoint.id,
            snapshot.run.rescue_used,
            &emitter,
        )
        .await;
    }

    let planned_scope = match snapshot(&state, &run_id).await {
        Ok(snapshot) => snapshot
            .work_items
            .into_iter()
            .flat_map(|item| item.scope_hints)
            .collect::<Vec<_>>(),
        Err(error) => {
            return pause_and_sync(
                &state,
                &requirement_id,
                &run_id,
                "load_validation_scope",
                &error.to_string(),
                &emitter,
            )
            .await;
        }
    };
    let catalog = match RepositoryValidationCatalog::discover_for_scope(
        &workspace.worktree,
        &planned_scope,
    ) {
        Ok(catalog) => catalog,
        Err(error) => {
            return pause_and_sync(
                &state,
                &requirement_id,
                &run_id,
                "discover_validation_catalog",
                &error.to_string(),
                &emitter,
            )
            .await;
        }
    };
    if let Err(error) =
        ensure_validation_baseline(&state, &run_id, &workspace.worktree, &catalog).await
    {
        return pause_and_sync(
            &state,
            &requirement_id,
            &run_id,
            "validation_baseline",
            &error.to_string(),
            &emitter,
        )
        .await;
    }

    let mut repair_security_recheck = false;
    loop {
        let snapshot = match snapshot(&state, &run_id).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return pause_and_sync(
                    &state,
                    &requirement_id,
                    &run_id,
                    "load_snapshot",
                    &error.to_string(),
                    &emitter,
                )
                .await;
            }
        };
        if snapshot.run.status == WorkflowRunStatus::PausedTechnical {
            return RequirementStatus::Running;
        }
        if snapshot.run.status.is_terminal() {
            return sync_terminal(&state, &requirement_id, snapshot.run.status, &emitter).await;
        }
        if snapshot.run.paused_operation == Some(PausedOperation::RemoteCiFix)
            && let (Some(mut publication), Some(checkpoint)) = (
                snapshot.publication.clone(),
                snapshot
                    .checkpoints
                    .iter()
                    .rev()
                    .find(|checkpoint| checkpoint.status == CheckpointStatus::Approved),
            )
        {
            let failure = publication
                .last_error
                .clone()
                .unwrap_or_else(|| "远端 CI 失败".to_owned());
            if let Err(error) = run_remote_ci_fix(
                &state,
                &run_id,
                &workspace,
                &mut publication,
                &failure,
                &emitter,
            )
            .await
            {
                return pause_and_sync(
                    &state,
                    &requirement_id,
                    &run_id,
                    "remote_ci_fix",
                    &error,
                    &emitter,
                )
                .await;
            }
            return publish_approved_workflow(
                &state,
                &requirement_id,
                &run_id,
                &workspace,
                &checkpoint.id,
                false,
                &emitter,
            )
            .await;
        }
        if snapshot
            .run
            .paused_operation
            .is_some_and(is_publication_resume_operation)
            && let Some(checkpoint) = snapshot
                .checkpoints
                .iter()
                .rev()
                .find(|checkpoint| checkpoint.status == CheckpointStatus::Approved)
        {
            return publish_approved_workflow(
                &state,
                &requirement_id,
                &run_id,
                &workspace,
                &checkpoint.id,
                snapshot.run.rescue_used,
                &emitter,
            )
            .await;
        }
        if snapshot.run.paused_operation.is_some_and(|operation| {
            matches!(
                operation,
                PausedOperation::CommitIntegration
                    | PausedOperation::FastForwardIntegration
                    | PausedOperation::PersistCompletion
                    | PausedOperation::RescueCommit
                    | PausedOperation::RescueIntegration
                    | PausedOperation::PersistRescueCompletion
                    | PausedOperation::BeginPublication
                    | PausedOperation::PublicationReadiness
                    | PausedOperation::PublicationPush
                    | PausedOperation::PersistPublicationPush
                    | PausedOperation::PublicationOpenReview
                    | PausedOperation::PersistPublicationReview
                    | PausedOperation::PublicationAutoMerge
                    | PausedOperation::PersistPublicationWait
                    | PausedOperation::PersistRemoteChecks
                    | PausedOperation::PublicationExternalAction
                    | PausedOperation::PublicationPoll
                    | PausedOperation::PersistRemoteMerge
                    | PausedOperation::PersistLocalSync
                    | PausedOperation::PersistCleanupStart
                    | PausedOperation::PublicationCleanup
                    | PausedOperation::PersistCleanupCompletion
                    | PausedOperation::ResumePublication
                    | PausedOperation::RemoteCiFailedAfterFix
            )
        }) && let Some(checkpoint) = snapshot
            .checkpoints
            .iter()
            .rev()
            .find(|checkpoint| checkpoint.status == CheckpointStatus::Approved)
        {
            let rescue = snapshot.run.paused_operation.is_some_and(|operation| {
                matches!(
                    operation,
                    PausedOperation::RescueCommit
                        | PausedOperation::RescueIntegration
                        | PausedOperation::RescueSnapshot
                        | PausedOperation::RescueAgent
                        | PausedOperation::RescueValidationOrReview
                )
            });
            return resume_approved_integration(
                &state,
                &requirement_id,
                &run_id,
                &workspace,
                &checkpoint.id,
                rescue,
                &emitter,
            )
            .await;
        }
        if snapshot.run.rescue_used
            && snapshot.attempts.iter().any(|attempt| {
                attempt.kind == WorkflowAttemptKind::Rescue
                    && attempt.status == WorkflowAttemptStatus::Succeeded
            })
        {
            return continue_existing_rescue(
                &state,
                &requirement_id,
                &run_id,
                &project,
                &model_settings,
                &workspace,
                &catalog,
                &snapshot,
                &emitter,
            )
            .await;
        }

        if !all_work_items_accepted(&snapshot) {
            match execute_next_work_batch(
                &state,
                &project,
                &model_settings,
                &workspace,
                &snapshot,
                &emitter,
            )
            .await
            {
                Ok(WorkItemOutcome::Continue) => continue,
                Ok(WorkItemOutcome::SemanticExhausted(reason)) => {
                    return rescue_once(
                        &state,
                        &requirement_id,
                        &run_id,
                        &project,
                        &model_settings,
                        &workspace,
                        &catalog,
                        &reason,
                        &emitter,
                    )
                    .await;
                }
                Err(technical) => {
                    let operation = if technical.starts_with("workspace_violation：") {
                        "workspace_violation"
                    } else {
                        "work_item_attempt"
                    };
                    return pause_and_sync(
                        &state,
                        &requirement_id,
                        &run_id,
                        operation,
                        &technical,
                        &emitter,
                    )
                    .await;
                }
            }
        }

        if let Err(error) = cleanup_integrated_item_workspaces(&state, &workspace, &snapshot).await
        {
            return pause_and_sync(
                &state,
                &requirement_id,
                &run_id,
                "item_workspace_cleanup",
                &error,
                &emitter,
            )
            .await;
        }

        match validate_and_review(
            &state,
            &run_id,
            &project,
            &model_settings,
            ReviewPass {
                workspace: &workspace,
                catalog: &catalog,
                kind: CheckpointKind::Final,
                repair_security_recheck,
            },
            &emitter,
        )
        .await
        {
            Ok(FinalDecision::Approved(checkpoint_id)) => {
                let commit =
                    match commit_integration_checkpoint(&workspace.worktree, "完成 WorkflowRun")
                        .await
                    {
                        Ok(commit) => commit,
                        Err(error) => {
                            return pause_and_sync(
                                &state,
                                &requirement_id,
                                &run_id,
                                "commit_integration",
                                &error.to_string(),
                                &emitter,
                            )
                            .await;
                        }
                    };
                let started = {
                    let store = state.store.read().await;
                    store.db.begin_workflow_publication(
                        &checkpoint_id,
                        &commit,
                        &format!("最终审核通过；integration commit {commit}"),
                    )
                };
                if let Err(error) = started {
                    return pause_and_sync(
                        &state,
                        &requirement_id,
                        &run_id,
                        "begin_publication",
                        &error.to_string(),
                        &emitter,
                    )
                    .await;
                }
                return publish_approved_workflow(
                    &state,
                    &requirement_id,
                    &run_id,
                    &workspace,
                    &checkpoint_id,
                    false,
                    &emitter,
                )
                .await;
            }
            Ok(FinalDecision::ValidationFailure(reason) | FinalDecision::ReviewFailure(reason)) => {
                if !has_integration_fix(&snapshot) {
                    match run_integration_fix(
                        &state,
                        &project,
                        &model_settings,
                        &workspace.worktree,
                        &snapshot,
                        &emitter,
                    )
                    .await
                    {
                        Ok(security_recheck) => {
                            repair_security_recheck = security_recheck;
                            continue;
                        }
                        Err(AttemptFailure::Technical(error)) => {
                            return pause_and_sync(
                                &state,
                                &requirement_id,
                                &run_id,
                                "integration_fix",
                                &error,
                                &emitter,
                            )
                            .await;
                        }
                        Err(AttemptFailure::Semantic(error)) => {
                            return rescue_once(
                                &state,
                                &requirement_id,
                                &run_id,
                                &project,
                                &model_settings,
                                &workspace,
                                &catalog,
                                &error,
                                &emitter,
                            )
                            .await;
                        }
                    }
                }
                return rescue_once(
                    &state,
                    &requirement_id,
                    &run_id,
                    &project,
                    &model_settings,
                    &workspace,
                    &catalog,
                    &reason,
                    &emitter,
                )
                .await;
            }
            Err(technical) => {
                return pause_and_sync(
                    &state,
                    &requirement_id,
                    &run_id,
                    "final_validation_or_review",
                    &technical,
                    &emitter,
                )
                .await;
            }
        }
    }
}

fn is_publication_resume_operation(operation: PausedOperation) -> bool {
    matches!(
        operation,
        PausedOperation::BeginPublication
            | PausedOperation::BeginRescuePublication
            | PausedOperation::LoadPublication
            | PausedOperation::LocalIntegration
            | PausedOperation::PersistLocalMerge
            | PausedOperation::PublicationReadiness
            | PausedOperation::PublicationPush
            | PausedOperation::PersistPublicationPush
            | PausedOperation::PublicationSnapshot
            | PausedOperation::PublicationOpenReview
            | PausedOperation::PersistPublicationReview
            | PausedOperation::PublicationAutoMerge
            | PausedOperation::PersistPublicationWait
            | PausedOperation::PersistRemoteChecks
            | PausedOperation::PersistRemoteCiFix
            | PausedOperation::RemoteCiFailedAfterFix
            | PausedOperation::PublicationExternalAction
            | PausedOperation::PublicationPoll
            | PausedOperation::PersistRemoteMerge
            | PausedOperation::PersistLocalSync
            | PausedOperation::PersistCleanupStart
            | PausedOperation::PublicationCleanup
            | PausedOperation::PersistCleanupCompletion
            | PausedOperation::PersistCompletion
    )
}

enum WorkItemOutcome {
    Continue,
    SemanticExhausted(String),
}

async fn execute_next_work_batch(
    state: &AppState,
    project: &crate::models::Project,
    model_settings: &crate::models::ModelSettings,
    integration: &crate::workflow::IntegrationWorkspace,
    snapshot: &WorkflowSnapshot,
    emitter: &RequirementEventEmitter,
) -> Result<WorkItemOutcome, String> {
    let integration_fingerprint = match clean_integration_fingerprint(integration).await {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            let store = state.store.read().await;
            let _ = store.db.record_workflow_event(
                &snapshot.run.id,
                "integration.guard_failed",
                &serde_json::json!({"phase": "before_agent", "reason": error.to_string()}),
            );
            emitter.emit(
                "integration_guard_failed",
                "integration worktree 非干净，已阻止启动 Agent。",
            );
            return Err(format!("workspace_violation：{error}"));
        }
    };
    let blocked = snapshot
        .work_items
        .iter()
        .find(|item| item.status == crate::workflow::WorkItemStatus::Blocked)
        .cloned();
    let claim_limit = if let Some(item) = &blocked {
        if next_attempt_policy(item).is_none() {
            return Ok(WorkItemOutcome::SemanticExhausted(format!(
                "工作项在低档实现、低档修复和高档修复后仍失败：{}",
                item.objective
            )));
        }
        1
    } else {
        runnable_batch_limit(snapshot)
    };
    let fuse_candidates = if let Some(item) = &blocked {
        vec![item]
    } else {
        runnable_items(snapshot)
            .into_iter()
            .take(claim_limit)
            .collect::<Vec<_>>()
    };
    {
        let store = state.store.read().await;
        for item in fuse_candidates {
            if let Some(class) = store
                .db
                .workflow_failure_fuse(&item.id, &integration_fingerprint)
                .map_err(|error| error.to_string())?
            {
                return Err(format!(
                    "确定性技术故障已熔断，未启动新的 Agent：{} ({class:?})",
                    item.objective
                ));
            }
        }
    }
    if let Some(item) = &blocked {
        let store = state.store.read().await;
        store
            .db
            .prepare_work_item_fix(&item.id)
            .map_err(|error| error.to_string())?;
    }
    let items = {
        let store = state.store.read().await;
        store.db.runnable_work_items(&snapshot.run.id, claim_limit)
    }
    .map_err(|error| error.to_string())?;
    if items.is_empty() {
        return Err("没有满足依赖的可运行工作项".to_owned());
    }
    emitter.emit(
        "parallel_batch_started",
        &format!("启动 {} 个隔离工作项。", items.len()),
    );

    struct RunningItem {
        item: crate::workflow::WorkItem,
        attempt: crate::workflow::WorkflowAttempt,
        workspace: ItemGitWorkspace,
    }

    let mut running = Vec::new();
    for item in items {
        let Some(policy) = next_attempt_policy(&item) else {
            return Ok(WorkItemOutcome::SemanticExhausted(format!(
                "工作项尝试次数已耗尽：{}",
                item.objective
            )));
        };
        let item_workspace =
            prepare_item_workspace(integration, &snapshot.run.id, &item.id, item.position)
                .await
                .map_err(|error| error.to_string())?;
        let fallback_serial = snapshot
            .item_workspaces
            .iter()
            .find(|workspace| workspace.work_item_id == item.id)
            .is_some_and(|workspace| workspace.fallback_serial);
        persist_item_workspace(
            state,
            &item_workspace,
            &snapshot.run.id,
            WorkflowItemWorkspaceStatus::Prepared,
            None,
            fallback_serial,
            "item_workspace.prepared",
        )
        .await?;
        let attempt = {
            let store = state.store.read().await;
            store.db.start_workflow_attempt(
                &snapshot.run.id,
                Some(&item.id),
                policy.kind,
                tier_label(policy.model_tier),
            )
        }
        .map_err(|error| error.to_string())?;
        persist_item_workspace(
            state,
            &item_workspace,
            &snapshot.run.id,
            WorkflowItemWorkspaceStatus::Running,
            None,
            fallback_serial,
            "item_workspace.running",
        )
        .await?;
        emitter.emit(
            "work_item_attempt_started",
            &format!("开始交付：{}（第 {} 次）", item.objective, attempt.ordinal),
        );
        running.push((item, attempt, item_workspace, policy));
    }

    let mut join_set = tokio::task::JoinSet::new();
    for (item, attempt, workspace, policy) in running {
        let provider = state.model_provider.clone();
        let input = WorkflowAgentInput {
            project: project.clone(),
            run: snapshot.run.clone(),
            work_item: Some(item.clone()),
            attempt_kind: policy.kind,
            model_tier: policy.model_tier,
            working_dir: workspace.worktree.clone(),
            open_blockers: latest_open_blockers(snapshot),
            recent_failures: snapshot.attempts.clone(),
            validation_evidence: snapshot.validations.clone(),
            model_settings: model_settings.clone(),
            resume_session_file: None,
            continuation_feedback: None,
        };
        let child_emitter = emitter.clone();
        join_set.spawn(async move {
            let result = provider
                .execute_workflow_attempt(input, Some(child_emitter))
                .await;
            (
                RunningItem {
                    item,
                    attempt,
                    workspace,
                },
                result,
            )
        });
    }
    let mut results = Vec::new();
    while let Some(result) = join_set.join_next().await {
        results.push(result.map_err(|error| format!("并行 Agent 任务异常退出：{error}"))?);
    }
    results.sort_by_key(|(running, _)| running.item.position);
    {
        let store = state.store.read().await;
        for (running, result) in &results {
            match result {
                Ok(output) => store.db.observe_workflow_attempt(
                    &running.attempt.id,
                    output.pi_session_file.as_deref(),
                    output.worktree_fingerprint.as_deref(),
                    Some(&output.result_summary),
                    output.usage.as_ref(),
                ),
                Err(error) => store.db.observe_workflow_attempt(
                    &running.attempt.id,
                    None,
                    None,
                    None,
                    error.trace(),
                ),
            }
            .map_err(|error| error.to_string())?;
        }
    }

    let integration_after = clean_integration_fingerprint(integration).await;
    if !matches!(
        integration_after.as_ref(),
        Ok(fingerprint) if fingerprint == &integration_fingerprint
    ) {
        let reason = integration_after
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "integration worktree 指纹在 Agent 运行期间发生变化".to_owned());
        {
            let store = state.store.read().await;
            store
                .db
                .record_workflow_event(
                    &snapshot.run.id,
                    "workspace.boundary_blocked",
                    &serde_json::json!({"phase": "after_agent", "reason": reason}),
                )
                .map_err(|error| error.to_string())?;
            for (running, result) in &results {
                store
                    .db
                    .record_workflow_failure_fuse(
                        &snapshot.run.id,
                        &running.item.id,
                        FailureClass::WorkspaceViolation,
                        &integration_fingerprint,
                    )
                    .map_err(|error| error.to_string())?;
                match result {
                    Ok(output) => store.db.finish_workflow_attempt(
                        &running.attempt.id,
                        false,
                        output.pi_session_file.as_deref(),
                        output.worktree_fingerprint.as_deref(),
                        Some(&output.result_summary),
                        Some(FailureClass::WorkspaceViolation),
                        Some(&reason),
                        output.usage.as_ref(),
                    ),
                    Err(error) => store.db.finish_workflow_attempt(
                        &running.attempt.id,
                        false,
                        None,
                        None,
                        None,
                        Some(FailureClass::WorkspaceViolation),
                        Some(&reason),
                        error.trace(),
                    ),
                }
                .map_err(|error| error.to_string())?;
            }
        }
        emitter.emit(
            "workspace_boundary_blocked",
            "Agent 修改了非分配 worktree，WorkflowRun 已技术暂停。",
        );
        return Err(format!("workspace_violation：{reason}"));
    }

    let batch_size = results.len();

    let mut integrated_paths = Vec::<String>::new();
    let mut technical_failure = None;
    let mut semantic_exhaustion = None;
    for (running, result) in results {
        let fallback_serial = snapshot
            .item_workspaces
            .iter()
            .find(|workspace| workspace.work_item_id == running.item.id)
            .is_some_and(|workspace| workspace.fallback_serial);
        match result {
            Ok(output) if output.completed => {
                let commit = match commit_item_workspace(
                    &running.workspace,
                    &running.item.objective,
                )
                .await
                {
                    Ok(commit) => commit,
                    Err(error) => {
                        let reason = error.to_string();
                        let store = state.store.read().await;
                        store
                            .db
                            .finish_workflow_attempt(
                                &running.attempt.id,
                                false,
                                output.pi_session_file.as_deref(),
                                output.worktree_fingerprint.as_deref(),
                                Some(&output.result_summary),
                                Some(FailureClass::GitConflict),
                                Some(&reason),
                                output.usage.as_ref(),
                            )
                            .map_err(|save| save.to_string())?;
                        store
                            .db
                            .record_workflow_failure_fuse(
                                &snapshot.run.id,
                                &running.item.id,
                                FailureClass::GitConflict,
                                &integration_fingerprint,
                            )
                            .map_err(|save| save.to_string())?;
                        return Err(reason);
                    }
                };
                let paths = if commit == running.workspace.base_commit {
                    Vec::new()
                } else {
                    match commit_changed_paths(&running.workspace.worktree, &commit).await {
                        Ok(paths) => paths,
                        Err(error) => {
                            let reason = error.to_string();
                            let store = state.store.read().await;
                            store
                                .db
                                .finish_workflow_attempt(
                                    &running.attempt.id,
                                    false,
                                    output.pi_session_file.as_deref(),
                                    output.worktree_fingerprint.as_deref(),
                                    Some(&output.result_summary),
                                    Some(FailureClass::GitConflict),
                                    Some(&reason),
                                    output.usage.as_ref(),
                                )
                                .map_err(|save| save.to_string())?;
                            store
                                .db
                                .record_workflow_failure_fuse(
                                    &snapshot.run.id,
                                    &running.item.id,
                                    FailureClass::GitConflict,
                                    &integration_fingerprint,
                                )
                                .map_err(|save| save.to_string())?;
                            return Err(reason);
                        }
                    }
                };
                let overlaps = paths.iter().any(|path| {
                    integrated_paths.iter().any(|integrated| {
                        let path = Path::new(path);
                        let integrated = Path::new(integrated);
                        path == integrated
                            || path.starts_with(integrated)
                            || integrated.starts_with(path)
                    })
                });
                if overlaps {
                    let reason = "并行任务实际改动路径重叠，降级为串行重跑";
                    if batch_size < 2 || fallback_serial {
                        {
                            let store = state.store.read().await;
                            store
                                .db
                                .finish_workflow_attempt(
                                    &running.attempt.id,
                                    false,
                                    output.pi_session_file.as_deref(),
                                    output.worktree_fingerprint.as_deref(),
                                    Some(&output.result_summary),
                                    Some(FailureClass::GitConflict),
                                    Some("串行降级后仍发生改动路径重叠"),
                                    output.usage.as_ref(),
                                )
                                .map_err(|error| error.to_string())?;
                            store
                                .db
                                .record_workflow_event(
                                    &snapshot.run.id,
                                    "parallel_batch.serial_fallback_exhausted",
                                    &serde_json::json!({"work_item_id": running.item.id}),
                                )
                                .map_err(|error| error.to_string())?;
                            store
                                .db
                                .record_workflow_failure_fuse(
                                    &snapshot.run.id,
                                    &running.item.id,
                                    FailureClass::GitConflict,
                                    &integration_fingerprint,
                                )
                                .map_err(|error| error.to_string())?;
                        }
                        return Err("串行降级后仍发生改动路径重叠".to_owned());
                    }
                    {
                        let store = state.store.read().await;
                        store.db.supersede_workflow_attempt(
                            &running.attempt.id,
                            reason,
                            output.pi_session_file.as_deref(),
                            output.worktree_fingerprint.as_deref(),
                            Some(&output.result_summary),
                            output.usage.as_ref(),
                        )
                    }
                    .map_err(|error| error.to_string())?;
                    cleanup_item_workspace(integration, &running.workspace)
                        .await
                        .map_err(|error| error.to_string())?;
                    persist_item_workspace(
                        state,
                        &running.workspace,
                        &snapshot.run.id,
                        WorkflowItemWorkspaceStatus::Cleaned,
                        Some(commit),
                        true,
                        "item_workspace.serial_fallback",
                    )
                    .await?;
                    continue;
                }
                if commit != running.workspace.base_commit
                    && let Err(error) = cherry_pick_item_commit(integration, &commit).await
                {
                    let reason = error.to_string();
                    {
                        let store = state.store.read().await;
                        store
                            .db
                            .finish_workflow_attempt(
                                &running.attempt.id,
                                false,
                                output.pi_session_file.as_deref(),
                                output.worktree_fingerprint.as_deref(),
                                Some(&output.result_summary),
                                Some(FailureClass::GitConflict),
                                Some(&reason),
                                output.usage.as_ref(),
                            )
                            .map_err(|save| save.to_string())?;
                        if fallback_serial {
                            store
                                .db
                                .record_workflow_event(
                                    &snapshot.run.id,
                                    "parallel_batch.serial_fallback_exhausted",
                                    &serde_json::json!({"work_item_id": running.item.id}),
                                )
                                .map_err(|save| save.to_string())?;
                        }
                        store
                            .db
                            .record_workflow_failure_fuse(
                                &snapshot.run.id,
                                &running.item.id,
                                FailureClass::GitConflict,
                                &integration_fingerprint,
                            )
                            .map_err(|save| save.to_string())?;
                    }
                    return Err(reason);
                }
                integrated_paths.extend(paths);
                {
                    let store = state.store.read().await;
                    store.db.finish_workflow_attempt(
                        &running.attempt.id,
                        true,
                        output.pi_session_file.as_deref(),
                        output.worktree_fingerprint.as_deref(),
                        Some(&output.result_summary),
                        None,
                        None,
                        output.usage.as_ref(),
                    )
                }
                .map_err(|error| error.to_string())?;
                persist_item_workspace(
                    state,
                    &running.workspace,
                    &snapshot.run.id,
                    WorkflowItemWorkspaceStatus::Integrated,
                    Some(commit.clone()),
                    fallback_serial,
                    "item_workspace.integrated",
                )
                .await?;
                cleanup_item_workspace(integration, &running.workspace)
                    .await
                    .map_err(|error| error.to_string())?;
                persist_item_workspace(
                    state,
                    &running.workspace,
                    &snapshot.run.id,
                    WorkflowItemWorkspaceStatus::Cleaned,
                    Some(commit),
                    fallback_serial,
                    "item_workspace.cleaned",
                )
                .await?;
                emitter.emit(
                    "work_item_completed",
                    &format!("已交付：{}", running.item.objective),
                );
            }
            Ok(output) => {
                {
                    let store = state.store.read().await;
                    store.db.finish_workflow_attempt(
                        &running.attempt.id,
                        false,
                        output.pi_session_file.as_deref(),
                        output.worktree_fingerprint.as_deref(),
                        Some(&output.result_summary),
                        Some(FailureClass::BehaviourConflict),
                        Some(&output.result_summary),
                        output.usage.as_ref(),
                    )
                }
                .map_err(|error| error.to_string())?;
                if running.item.attempt_count + 1 >= 3 {
                    semantic_exhaustion = Some(output.result_summary);
                }
            }
            Err(error) => {
                let class = classify_error(&error);
                {
                    let store = state.store.read().await;
                    store.db.finish_workflow_attempt(
                        &running.attempt.id,
                        false,
                        None,
                        None,
                        None,
                        Some(class),
                        Some(&error.to_string()),
                        error.trace(),
                    )
                }
                .map_err(|save| save.to_string())?;
                if class.is_technical() {
                    technical_failure.get_or_insert_with(|| error.to_string());
                } else if running.item.attempt_count + 1 >= 3 {
                    semantic_exhaustion.get_or_insert_with(|| error.to_string());
                }
            }
        }
    }
    if let Some(error) = technical_failure {
        Err(error)
    } else if let Some(error) = semantic_exhaustion {
        Ok(WorkItemOutcome::SemanticExhausted(error))
    } else {
        Ok(WorkItemOutcome::Continue)
    }
}

fn runnable_items(snapshot: &WorkflowSnapshot) -> Vec<&crate::workflow::WorkItem> {
    let accepted = snapshot
        .work_items
        .iter()
        .filter(|item| item.status == crate::workflow::WorkItemStatus::Accepted)
        .map(|item| item.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    snapshot
        .work_items
        .iter()
        .filter(|item| item.status == crate::workflow::WorkItemStatus::Pending)
        .filter(|item| {
            snapshot
                .dependencies
                .iter()
                .filter(|dependency| dependency.work_item_id == item.id)
                .all(|dependency| accepted.contains(dependency.depends_on_id.as_str()))
        })
        .collect()
}

fn runnable_batch_limit(snapshot: &WorkflowSnapshot) -> usize {
    let runnable = runnable_items(snapshot);
    if runnable.len() < 2
        || runnable.iter().enumerate().any(|(index, left)| {
            runnable
                .iter()
                .skip(index + 1)
                .any(|right| !crate::workflow::may_run_in_parallel(left, right))
        })
    {
        1
    } else {
        runnable.len().min(3)
    }
}

#[allow(clippy::too_many_arguments)]
async fn persist_item_workspace(
    state: &AppState,
    workspace: &ItemGitWorkspace,
    run_id: &str,
    status: WorkflowItemWorkspaceStatus,
    result_commit: Option<String>,
    fallback_serial: bool,
    event_type: &str,
) -> Result<(), String> {
    let record = WorkflowItemWorkspace {
        work_item_id: workspace.work_item_id.clone(),
        run_id: run_id.to_owned(),
        branch: workspace.branch.clone(),
        worktree_path: workspace.worktree.to_string_lossy().into_owned(),
        base_commit: workspace.base_commit.clone(),
        result_commit,
        status,
        fallback_serial,
        updated_at: Utc::now(),
    };
    let store = state.store.read().await;
    store
        .db
        .upsert_workflow_item_workspace(&record, event_type)
        .map_err(|error| error.to_string())
}

async fn cleanup_integrated_item_workspaces(
    state: &AppState,
    integration: &crate::workflow::IntegrationWorkspace,
    snapshot: &WorkflowSnapshot,
) -> Result<(), String> {
    for record in snapshot.item_workspaces.iter().filter(|record| {
        record.status == WorkflowItemWorkspaceStatus::Integrated
            || record.status == WorkflowItemWorkspaceStatus::Committed
    }) {
        let workspace = ItemGitWorkspace {
            work_item_id: record.work_item_id.clone(),
            worktree: std::path::PathBuf::from(&record.worktree_path),
            branch: record.branch.clone(),
            base_commit: record.base_commit.clone(),
        };
        cleanup_item_workspace(integration, &workspace)
            .await
            .map_err(|error| error.to_string())?;
        persist_item_workspace(
            state,
            &workspace,
            &snapshot.run.id,
            WorkflowItemWorkspaceStatus::Cleaned,
            record.result_commit.clone(),
            record.fallback_serial,
            "item_workspace.cleaned",
        )
        .await?;
    }
    Ok(())
}

enum FinalDecision {
    Approved(String),
    ValidationFailure(String),
    ReviewFailure(String),
}

struct ReviewPass<'a> {
    workspace: &'a crate::workflow::IntegrationWorkspace,
    catalog: &'a RepositoryValidationCatalog,
    kind: CheckpointKind,
    repair_security_recheck: bool,
}

async fn validate_and_review(
    state: &AppState,
    run_id: &str,
    project: &crate::models::Project,
    model_settings: &crate::models::ModelSettings,
    pass: ReviewPass<'_>,
    emitter: &RequirementEventEmitter,
) -> Result<FinalDecision, String> {
    {
        let store = state.store.read().await;
        store
            .db
            .transition_workflow_run(run_id, WorkflowRunStatus::Validating, None)
            .map_err(|error| error.to_string())?;
    }
    stage_integration_changes(&pass.workspace.worktree)
        .await
        .map_err(|error| error.to_string())?;
    let fingerprint = worktree_fingerprint(&pass.workspace.worktree)
        .await
        .map_err(|error| error.to_string())?;
    let validations = run_final_catalog(
        state,
        run_id,
        &pass.workspace.worktree,
        pass.catalog,
        &fingerprint,
    )
    .await?;
    let regressions = validations
        .iter()
        .filter(|validation| {
            validation.gating
                && validation.baseline_status == ValidationRunStatus::Passed
                && validation.final_status == ValidationRunStatus::Failed
        })
        .collect::<Vec<_>>();
    if !regressions.is_empty() {
        return Ok(FinalDecision::ValidationFailure(format!(
            "新增仓库原生验证回归：{}",
            regressions
                .iter()
                .map(|validation| validation.command.as_str())
                .collect::<Vec<_>>()
                .join("、")
        )));
    }
    let diff = staged_integration_diff(&pass.workspace.worktree)
        .await
        .map_err(|error| error.to_string())?;
    let paths = diff_paths(&diff);
    let current = snapshot(state, run_id)
        .await
        .map_err(|error| error.to_string())?;
    let angles =
        review_angles_for_checkpoint(&current, &paths, &diff, pass.repair_security_recheck);
    let checkpoint = {
        let store = state.store.read().await;
        store
            .db
            .create_checkpoint(run_id, pass.kind, &fingerprint, &angles)
            .map_err(|error| error.to_string())?
    };
    emitter.emit(
        "final_review_started",
        &format!("最终审核启动：{} 个隔离角度", angles.len()),
    );
    let output = match state
        .model_provider
        .review_workflow_checkpoint(
            WorkflowReviewInput {
                project: project.clone(),
                run: current.run.clone(),
                checkpoint: checkpoint.clone(),
                working_dir: pass.workspace.worktree.clone(),
                validation_evidence: validations,
                prior_findings: current.findings.clone(),
                model_settings: model_settings.clone(),
            },
            Some(emitter.clone()),
        )
        .await
    {
        Ok(output) => output,
        Err(error) => {
            let message = error.to_string();
            let store = state.store.read().await;
            let _ = store.db.finish_checkpoint(
                &checkpoint.id,
                CheckpointStatus::TechnicalFailure,
                &message,
            );
            return Err(message);
        }
    };
    if let Some(error) = output.technical_failure {
        let completed_angles = completed_review_angles(output.details.as_ref());
        let store = state.store.read().await;
        store
            .db
            .record_checkpoint_review_observation(
                &checkpoint.id,
                output.details.as_ref(),
                output.usage.as_ref(),
            )
            .map_err(|persist| format!("{error}；保存审核观察失败：{persist}"))?;
        if !completed_angles.is_empty() {
            store
                .db
                .store_review_findings(&checkpoint.id, &output.findings, &completed_angles)
                .map_err(|persist| format!("{error}；保存已完成角度失败：{persist}"))?;
        }
        store
            .db
            .finish_checkpoint(&checkpoint.id, CheckpointStatus::TechnicalFailure, &error)
            .map_err(|persist| format!("{error}；保存技术失败失败：{persist}"))?;
        return Err(error);
    }
    let _findings = {
        let store = state.store.read().await;
        store
            .db
            .record_checkpoint_review_observation(
                &checkpoint.id,
                output.details.as_ref(),
                output.usage.as_ref(),
            )
            .map_err(|error| error.to_string())?;
        store
            .db
            .store_review_findings(
                &checkpoint.id,
                &output.findings,
                &checkpoint.required_angles,
            )
            .map_err(|error| error.to_string())?
    };
    let ledger = snapshot(state, run_id)
        .await
        .map_err(|error| error.to_string())?
        .findings;
    let blockers = ledger
        .iter()
        .filter(|finding| finding.priority.is_blocking() && finding.status == FindingStatus::Open)
        .count();
    let advisories = ledger
        .iter()
        .filter(|finding| !finding.priority.is_blocking() && finding.status == FindingStatus::Open)
        .count();
    if blockers == 0 {
        let store = state.store.read().await;
        store
            .db
            .finish_checkpoint(
                &checkpoint.id,
                CheckpointStatus::Approved,
                &format!("审核通过：0 个 P0/P1；{advisories} 个 P2/P3"),
            )
            .map_err(|error| error.to_string())?;
        Ok(FinalDecision::Approved(checkpoint.id))
    } else {
        let store = state.store.read().await;
        store
            .db
            .finish_checkpoint(
                &checkpoint.id,
                CheckpointStatus::Rejected,
                &format!("审核不通过：{blockers} 个 P0/P1"),
            )
            .map_err(|error| error.to_string())?;
        Ok(FinalDecision::ReviewFailure(format!(
            "最终审核仍有 {blockers} 个 P0/P1"
        )))
    }
}

async fn ensure_validation_baseline(
    state: &AppState,
    run_id: &str,
    working_dir: &Path,
    catalog: &RepositoryValidationCatalog,
) -> Result<(), AppError> {
    let existing = snapshot(state, run_id).await?.validations;
    for command in &catalog.commands {
        if existing
            .iter()
            .any(|validation| validation.command == command.display)
        {
            continue;
        }
        let result = execute_catalog_command(working_dir, command).await;
        let validation = WorkflowValidation {
            id: new_workflow_id("validation"),
            run_id: run_id.to_owned(),
            attempt_id: None,
            checkpoint_id: None,
            command: command.display.clone(),
            source: ValidationSource::RepositoryCatalog,
            gating: true,
            baseline_status: result.status,
            final_status: ValidationRunStatus::Pending,
            baseline_exit_code: result.exit_code,
            final_exit_code: None,
            output_summary: Some(result.output_summary),
            worktree_fingerprint: worktree_fingerprint(working_dir).await?,
            created_at: Utc::now(),
            completed_at: None,
        };
        let store = state.store.read().await;
        store.db.record_workflow_validation(&validation)?;
    }
    Ok(())
}

async fn run_final_catalog(
    state: &AppState,
    run_id: &str,
    working_dir: &Path,
    catalog: &RepositoryValidationCatalog,
    fingerprint: &str,
) -> Result<Vec<WorkflowValidation>, String> {
    let baseline = snapshot(state, run_id)
        .await
        .map_err(|error| error.to_string())?
        .validations;
    let mut completed = Vec::new();
    for command in &catalog.commands {
        let result = execute_catalog_command(working_dir, command).await;
        let previous = baseline
            .iter()
            .find(|validation| validation.command == command.display);
        let validation = WorkflowValidation {
            id: previous
                .map(|validation| validation.id.clone())
                .unwrap_or_else(|| new_workflow_id("validation")),
            run_id: run_id.to_owned(),
            attempt_id: None,
            checkpoint_id: None,
            command: command.display.clone(),
            source: ValidationSource::RepositoryCatalog,
            gating: true,
            baseline_status: previous
                .map(|validation| validation.baseline_status)
                .unwrap_or(ValidationRunStatus::Unavailable),
            final_status: result.status,
            baseline_exit_code: previous.and_then(|validation| validation.baseline_exit_code),
            final_exit_code: result.exit_code,
            output_summary: Some(
                match previous.and_then(|value| value.output_summary.as_deref()) {
                    Some(baseline) => {
                        format!("baseline:\n{baseline}\n\nfinal:\n{}", result.output_summary)
                    }
                    None => format!("final:\n{}", result.output_summary),
                },
            ),
            worktree_fingerprint: fingerprint.to_owned(),
            created_at: previous
                .map(|validation| validation.created_at)
                .unwrap_or_else(Utc::now),
            completed_at: Some(Utc::now()),
        };
        {
            let store = state.store.read().await;
            store
                .db
                .record_workflow_validation(&validation)
                .map_err(|error| error.to_string())?;
        }
        completed.push(validation);
    }
    Ok(completed)
}

enum AttemptFailure {
    Technical(String),
    Semantic(String),
}

async fn run_integration_fix(
    state: &AppState,
    project: &crate::models::Project,
    model_settings: &crate::models::ModelSettings,
    working_dir: &Path,
    snapshot: &WorkflowSnapshot,
    emitter: &RequirementEventEmitter,
) -> Result<bool, AttemptFailure> {
    {
        let store = state.store.read().await;
        store
            .db
            .transition_workflow_run(&snapshot.run.id, WorkflowRunStatus::Fixing, None)
            .map_err(|error| AttemptFailure::Technical(error.to_string()))?;
    }
    let attempt = {
        let store = state.store.read().await;
        store.db.start_workflow_attempt(
            &snapshot.run.id,
            None,
            WorkflowAttemptKind::IntegrationFix,
            "high",
        )
    }
    .map_err(|error| AttemptFailure::Technical(error.to_string()))?;
    emitter.emit("integration_fix_started", "开始唯一一次高档集成修复。");
    let before_diff = staged_integration_diff(working_dir)
        .await
        .map_err(|error| AttemptFailure::Technical(error.to_string()))?;
    let result = state
        .model_provider
        .execute_workflow_attempt(
            WorkflowAgentInput {
                project: project.clone(),
                run: snapshot.run.clone(),
                work_item: None,
                attempt_kind: WorkflowAttemptKind::IntegrationFix,
                model_tier: RequirementModelTier::High,
                working_dir: working_dir.to_path_buf(),
                open_blockers: latest_open_blockers(snapshot),
                recent_failures: snapshot.attempts.clone(),
                validation_evidence: snapshot.validations.clone(),
                model_settings: model_settings.clone(),
                resume_session_file: None,
                continuation_feedback: None,
            },
            Some(emitter.clone()),
        )
        .await;
    finish_run_level_attempt(state, &attempt.id, result).await?;
    stage_integration_changes(working_dir)
        .await
        .map_err(|error| AttemptFailure::Technical(error.to_string()))?;
    let after_diff = staged_integration_diff(working_dir)
        .await
        .map_err(|error| AttemptFailure::Technical(error.to_string()))?;
    Ok(repair_diff_triggers_security(&before_diff, &after_diff))
}

async fn finish_run_level_attempt(
    state: &AppState,
    attempt_id: &str,
    result: Result<crate::workflow::WorkflowAgentOutput, AppError>,
) -> Result<crate::workflow::WorkflowAgentOutput, AttemptFailure> {
    match result {
        Ok(output) if output.completed => {
            let store = state.store.read().await;
            store
                .db
                .finish_workflow_attempt(
                    attempt_id,
                    true,
                    output.pi_session_file.as_deref(),
                    output.worktree_fingerprint.as_deref(),
                    Some(&output.result_summary),
                    None,
                    None,
                    output.usage.as_ref(),
                )
                .map_err(|error| AttemptFailure::Technical(error.to_string()))?;
            Ok(output)
        }
        Ok(output) => {
            let store = state.store.read().await;
            store
                .db
                .finish_workflow_attempt(
                    attempt_id,
                    false,
                    output.pi_session_file.as_deref(),
                    output.worktree_fingerprint.as_deref(),
                    Some(&output.result_summary),
                    Some(FailureClass::BehaviourConflict),
                    Some(&output.result_summary),
                    output.usage.as_ref(),
                )
                .map_err(|error| AttemptFailure::Technical(error.to_string()))?;
            Err(AttemptFailure::Semantic(output.result_summary))
        }
        Err(error) => {
            let class = classify_error(&error);
            let store = state.store.read().await;
            store
                .db
                .finish_workflow_attempt(
                    attempt_id,
                    false,
                    None,
                    None,
                    None,
                    Some(class),
                    Some(&error.to_string()),
                    error.trace(),
                )
                .map_err(|save| AttemptFailure::Technical(save.to_string()))?;
            if class.is_technical() {
                Err(AttemptFailure::Technical(error.to_string()))
            } else {
                Err(AttemptFailure::Semantic(error.to_string()))
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn continue_existing_rescue(
    state: &AppState,
    requirement_id: &str,
    run_id: &str,
    project: &crate::models::Project,
    model_settings: &crate::models::ModelSettings,
    workspace: &crate::workflow::IntegrationWorkspace,
    catalog: &RepositoryValidationCatalog,
    current: &WorkflowSnapshot,
    emitter: &RequirementEventEmitter,
) -> RequirementStatus {
    let successful_turns = current
        .attempts
        .iter()
        .filter(|attempt| {
            attempt.kind == WorkflowAttemptKind::Rescue
                && attempt.status == WorkflowAttemptStatus::Succeeded
        })
        .collect::<Vec<_>>();
    let latest_session = successful_turns
        .last()
        .and_then(|attempt| attempt.pi_session_file.as_deref());
    emitter.emit(
        "workflow_rescue_resumed",
        "从已完成的 Rescue 修改之后继续验证或审核。",
    );
    let mut decision = validate_and_review(
        state,
        run_id,
        project,
        model_settings,
        ReviewPass {
            workspace,
            catalog,
            kind: CheckpointKind::Rescue,
            repair_security_recheck: true,
        },
        emitter,
    )
    .await;
    if successful_turns.len() == 1
        && let Ok(FinalDecision::ValidationFailure(reason)) = &decision
    {
        decision = run_rescue_feedback(
            state,
            run_id,
            project,
            model_settings,
            workspace,
            latest_session,
            reason,
            catalog,
            emitter,
        )
        .await;
    }
    finish_rescue_decision(state, requirement_id, run_id, workspace, decision, emitter).await
}

#[allow(clippy::too_many_arguments)]
async fn rescue_once(
    state: &AppState,
    requirement_id: &str,
    run_id: &str,
    project: &crate::models::Project,
    model_settings: &crate::models::ModelSettings,
    workspace: &crate::workflow::IntegrationWorkspace,
    catalog: &RepositoryValidationCatalog,
    trigger: &str,
    emitter: &RequirementEventEmitter,
) -> RequirementStatus {
    let current = match snapshot(state, run_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return pause_and_sync(
                state,
                requirement_id,
                run_id,
                "rescue_snapshot",
                &error.to_string(),
                emitter,
            )
            .await;
        }
    };
    if current.run.rescue_used {
        return block_and_sync(state, requirement_id, run_id, trigger, emitter).await;
    }
    if let Err(error) = stage_integration_changes(&workspace.worktree).await {
        return pause_and_sync(
            state,
            requirement_id,
            run_id,
            "stage_before_rescue",
            &error.to_string(),
            emitter,
        )
        .await;
    }
    let before_diff = match staged_integration_diff(&workspace.worktree).await {
        Ok(diff) => diff,
        Err(error) => {
            return pause_and_sync(
                state,
                requirement_id,
                run_id,
                "snapshot_before_rescue",
                &error.to_string(),
                emitter,
            )
            .await;
        }
    };
    let attempt = {
        let store = state.store.read().await;
        store.db.begin_run_rescue(run_id, trigger)
    };
    let attempt = match attempt {
        Ok(attempt) => attempt,
        Err(error) => {
            return pause_and_sync(
                state,
                requirement_id,
                run_id,
                "begin_rescue",
                &error.to_string(),
                emitter,
            )
            .await;
        }
    };
    emitter.emit("workflow_rescue_started", "启动唯一一次外部高级 Rescue。");
    let result = state
        .model_provider
        .execute_workflow_attempt(
            WorkflowAgentInput {
                project: project.clone(),
                run: current.run.clone(),
                work_item: None,
                attempt_kind: WorkflowAttemptKind::Rescue,
                model_tier: RequirementModelTier::High,
                working_dir: workspace.worktree.clone(),
                open_blockers: latest_open_blockers(&current),
                recent_failures: current.attempts.clone(),
                validation_evidence: current.validations.clone(),
                model_settings: model_settings.clone(),
                resume_session_file: None,
                continuation_feedback: None,
            },
            Some(emitter.clone()),
        )
        .await;
    let rescue_output = match finish_run_level_attempt(state, &attempt.id, result).await {
        Ok(output) => output,
        Err(AttemptFailure::Technical(error)) => {
            return pause_and_sync(
                state,
                requirement_id,
                run_id,
                "rescue_agent",
                &error,
                emitter,
            )
            .await;
        }
        Err(AttemptFailure::Semantic(error)) => {
            return block_and_sync(state, requirement_id, run_id, &error, emitter).await;
        }
    };
    if let Err(error) = stage_integration_changes(&workspace.worktree).await {
        return pause_and_sync(
            state,
            requirement_id,
            run_id,
            "stage_rescue_changes",
            &error.to_string(),
            emitter,
        )
        .await;
    }
    let after_diff = match staged_integration_diff(&workspace.worktree).await {
        Ok(diff) => diff,
        Err(error) => {
            return pause_and_sync(
                state,
                requirement_id,
                run_id,
                "snapshot_after_rescue",
                &error.to_string(),
                emitter,
            )
            .await;
        }
    };
    let mut decision = validate_and_review(
        state,
        run_id,
        project,
        model_settings,
        ReviewPass {
            workspace,
            catalog,
            kind: CheckpointKind::Rescue,
            repair_security_recheck: repair_diff_triggers_security(&before_diff, &after_diff),
        },
        emitter,
    )
    .await;
    if let Ok(FinalDecision::ValidationFailure(reason)) = &decision {
        emitter.emit(
            "workflow_rescue_feedback_started",
            "原生验证未通过，将精简证据反馈给同一个 Rescue 会话一次。",
        );
        decision = run_rescue_feedback(
            state,
            run_id,
            project,
            model_settings,
            workspace,
            rescue_output.pi_session_file.as_deref(),
            reason,
            catalog,
            emitter,
        )
        .await;
    }
    finish_rescue_decision(state, requirement_id, run_id, workspace, decision, emitter).await
}

async fn finish_rescue_decision(
    state: &AppState,
    requirement_id: &str,
    run_id: &str,
    workspace: &crate::workflow::IntegrationWorkspace,
    decision: Result<FinalDecision, String>,
    emitter: &RequirementEventEmitter,
) -> RequirementStatus {
    match decision {
        Ok(FinalDecision::Approved(checkpoint_id)) => {
            let commit = match commit_integration_checkpoint(
                &workspace.worktree,
                "Rescue WorkflowRun",
            )
            .await
            {
                Ok(commit) => commit,
                Err(error) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "rescue_commit",
                        &error.to_string(),
                        emitter,
                    )
                    .await;
                }
            };
            let started = {
                let store = state.store.read().await;
                store.db.begin_workflow_publication(
                    &checkpoint_id,
                    &commit,
                    &format!("Rescue 审核通过；integration commit {commit}"),
                )
            };
            if let Err(error) = started {
                return pause_and_sync(
                    state,
                    requirement_id,
                    run_id,
                    "begin_rescue_publication",
                    &error.to_string(),
                    emitter,
                )
                .await;
            }
            publish_approved_workflow(
                state,
                requirement_id,
                run_id,
                workspace,
                &checkpoint_id,
                true,
                emitter,
            )
            .await
        }
        Ok(FinalDecision::ValidationFailure(error) | FinalDecision::ReviewFailure(error)) => {
            block_and_sync(state, requirement_id, run_id, &error, emitter).await
        }
        Err(error) => {
            pause_and_sync(
                state,
                requirement_id,
                run_id,
                "rescue_validation_or_review",
                &error,
                emitter,
            )
            .await
        }
    }
}

async fn resume_approved_integration(
    state: &AppState,
    requirement_id: &str,
    run_id: &str,
    workspace: &crate::workflow::IntegrationWorkspace,
    checkpoint_id: &str,
    rescue: bool,
    emitter: &RequirementEventEmitter,
) -> RequirementStatus {
    emitter.emit(
        "workflow_integration_resumed",
        "审核已经通过，仅重试未完成的提交、快进或状态持久化。",
    );
    let title = if rescue {
        "Rescue WorkflowRun"
    } else {
        "完成 WorkflowRun"
    };
    let commit = match commit_integration_checkpoint(&workspace.worktree, title).await {
        Ok(commit) => commit,
        Err(error) => {
            return pause_and_sync(
                state,
                requirement_id,
                run_id,
                if rescue {
                    "rescue_commit"
                } else {
                    "commit_integration"
                },
                &error.to_string(),
                emitter,
            )
            .await;
        }
    };
    let started = {
        let store = state.store.read().await;
        store.db.begin_workflow_publication(
            checkpoint_id,
            &commit,
            &format!("恢复终端集成步骤；integration commit {commit}"),
        )
    };
    if let Err(error) = started {
        return pause_and_sync(
            state,
            requirement_id,
            run_id,
            "resume_publication",
            &error.to_string(),
            emitter,
        )
        .await;
    }
    publish_approved_workflow(
        state,
        requirement_id,
        run_id,
        workspace,
        checkpoint_id,
        rescue,
        emitter,
    )
    .await
}

async fn attach_workspace(
    state: &AppState,
    run_id: &str,
    workspace: &crate::workflow::IntegrationWorkspace,
) -> Result<(), AppError> {
    let worktree = workspace
        .worktree
        .to_str()
        .ok_or_else(|| AppError::bad_request("worktree 路径不是 UTF-8"))?;
    let store = state.store.read().await;
    store
        .db
        .attach_workflow_workspace(run_id, &workspace.base_head, &workspace.branch, worktree)
}

fn workspace_from_snapshot(
    project_path: &str,
    snapshot: &WorkflowSnapshot,
) -> Result<crate::workflow::IntegrationWorkspace, AppError> {
    let project_root =
        crate::utils::resolve_git_root(Some(Path::new(project_path)), Path::new(project_path))?;
    let worktree = snapshot
        .run
        .integration_worktree
        .as_deref()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| AppError::conflict("WorkflowRun 缺少 integration worktree 记录"))?;
    let managed_run_root = worktree
        .file_name()
        .is_some_and(|name| name == "integration")
        .then(|| worktree.parent().map(std::path::Path::to_path_buf))
        .flatten()
        .unwrap_or_else(|| worktree.clone());
    Ok(crate::workflow::IntegrationWorkspace {
        project_root,
        managed_run_root,
        worktree,
        branch: snapshot
            .run
            .integration_branch
            .clone()
            .ok_or_else(|| AppError::conflict("WorkflowRun 缺少 integration 分支记录"))?,
        base_head: snapshot
            .run
            .base_head
            .clone()
            .ok_or_else(|| AppError::conflict("WorkflowRun 缺少 base HEAD 记录"))?,
    })
}

async fn publish_approved_workflow(
    state: &AppState,
    requirement_id: &str,
    run_id: &str,
    workspace: &crate::workflow::IntegrationWorkspace,
    checkpoint_id: &str,
    accept_all_work_items: bool,
    emitter: &RequirementEventEmitter,
) -> RequirementStatus {
    let mut publication = match snapshot(state, run_id)
        .await
        .ok()
        .and_then(|snapshot| snapshot.publication)
    {
        Some(publication) => publication,
        None => {
            return pause_and_sync(
                state,
                requirement_id,
                run_id,
                "load_publication",
                "WorkflowRun 缺少冻结发布配置",
                emitter,
            )
            .await;
        }
    };

    if publication.mode == WorkflowPublicationMode::Local {
        if publication.phase == WorkflowPublicationPhase::Prepared {
            let final_commit = match integrate_workflow_branch(workspace).await {
                Ok(commit) => commit,
                Err(error) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "local_integration",
                        &error.to_string(),
                        emitter,
                    )
                    .await;
                }
            };
            publication.phase = WorkflowPublicationPhase::Merged;
            publication.merge_commit = Some(final_commit);
            publication.local_sync_status = WorkflowLocalSyncStatus::Synced;
            publication.updated_at = Utc::now();
            if let Err(error) = save_publication(
                state,
                &publication,
                "publication.merged",
                serde_json::json!({"mode": "local", "merge_commit": publication.merge_commit}),
            )
            .await
            {
                return pause_and_sync(
                    state,
                    requirement_id,
                    run_id,
                    "persist_local_merge",
                    &error.to_string(),
                    emitter,
                )
                .await;
            }
        }
    } else {
        if publication.phase == WorkflowPublicationPhase::Prepared {
            let readiness = crate::api::publication::check(
                &workspace.project_root,
                &publication.origin,
                crate::config::CommitMode::PullRequest,
            )
            .await;
            if !readiness.ready {
                return pause_and_sync(
                    state,
                    requirement_id,
                    run_id,
                    "publication_readiness",
                    &readiness.issues.join("；"),
                    emitter,
                )
                .await;
            }
            let head = match push_workflow_branch(workspace).await {
                Ok(head) => head,
                Err(error) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "publication_push",
                        &error.to_string(),
                        emitter,
                    )
                    .await;
                }
            };
            publication.phase = WorkflowPublicationPhase::Pushed;
            publication.head_commit = Some(head);
            publication.updated_at = Utc::now();
            if let Err(error) = save_publication(
                state,
                &publication,
                "publication.pushed",
                serde_json::json!({"head_commit": publication.head_commit}),
            )
            .await
            {
                return pause_and_sync(
                    state,
                    requirement_id,
                    run_id,
                    "persist_publication_push",
                    &error.to_string(),
                    emitter,
                )
                .await;
            }
        }
        if publication.phase == WorkflowPublicationPhase::Pushed {
            let current = match snapshot(state, run_id).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "publication_snapshot",
                        &error.to_string(),
                        emitter,
                    )
                    .await;
                }
            };
            let (title, body) = publication_copy(&current);
            let review_url = match open_remote_review(workspace, &publication, &title, &body).await
            {
                Ok(url) => url,
                Err(error) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "publication_open_review",
                        &error.to_string(),
                        emitter,
                    )
                    .await;
                }
            };
            publication.review_url = Some(review_url);
            publication.phase = WorkflowPublicationPhase::ReviewOpen;
            publication.updated_at = Utc::now();
            if let Err(error) = save_publication(
                state,
                &publication,
                "publication.review_open",
                serde_json::json!({"url": publication.review_url}),
            )
            .await
            {
                return pause_and_sync(
                    state,
                    requirement_id,
                    run_id,
                    "persist_publication_review",
                    &error.to_string(),
                    emitter,
                )
                .await;
            }
        }
        if publication.phase == WorkflowPublicationPhase::ReviewOpen {
            match remote_review_state(workspace, &publication).await {
                Ok(RemoteReviewState::Merged { commit }) => {
                    publication.phase = WorkflowPublicationPhase::Merged;
                    publication.merge_commit = Some(commit);
                }
                Ok(RemoteReviewState::Blocked { reason }) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "publication_external_action",
                        &reason,
                        emitter,
                    )
                    .await;
                }
                Ok(RemoteReviewState::Waiting { .. } | RemoteReviewState::ChecksFailed { .. }) => {
                    if let Err(error) = arm_remote_auto_merge(workspace, &publication).await {
                        return pause_and_sync(
                            state,
                            requirement_id,
                            run_id,
                            "publication_auto_merge",
                            &error.to_string(),
                            emitter,
                        )
                        .await;
                    }
                    publication.phase = WorkflowPublicationPhase::WaitingChecks;
                }
                Err(error) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "publication_poll",
                        &error.to_string(),
                        emitter,
                    )
                    .await;
                }
            }
            publication.updated_at = Utc::now();
            if let Err(error) = save_publication(
                state,
                &publication,
                if publication.phase == WorkflowPublicationPhase::Merged {
                    "publication.merged"
                } else {
                    "publication.waiting_checks"
                },
                serde_json::json!({
                    "url": publication.review_url,
                    "merge_commit": publication.merge_commit,
                }),
            )
            .await
            {
                return pause_and_sync(
                    state,
                    requirement_id,
                    run_id,
                    "persist_publication_wait",
                    &error.to_string(),
                    emitter,
                )
                .await;
            }
        }
        let mut last_wait_summary = None;
        while publication.phase == WorkflowPublicationPhase::WaitingChecks {
            if snapshot(state, run_id)
                .await
                .is_ok_and(|snapshot| snapshot.run.status == WorkflowRunStatus::Cancelled)
            {
                return sync_terminal(state, requirement_id, WorkflowRunStatus::Cancelled, emitter)
                    .await;
            }
            match remote_review_state(workspace, &publication).await {
                Ok(RemoteReviewState::Merged { commit }) => {
                    publication.phase = WorkflowPublicationPhase::Merged;
                    publication.merge_commit = Some(commit);
                    publication.updated_at = Utc::now();
                    if let Err(error) = save_publication(
                        state,
                        &publication,
                        "publication.merged",
                        serde_json::json!({"merge_commit": publication.merge_commit}),
                    )
                    .await
                    {
                        return pause_and_sync(
                            state,
                            requirement_id,
                            run_id,
                            "persist_remote_merge",
                            &error.to_string(),
                            emitter,
                        )
                        .await;
                    }
                }
                Ok(RemoteReviewState::Waiting { summary }) => {
                    if last_wait_summary.as_deref() != Some(summary.as_str()) {
                        publication.updated_at = Utc::now();
                        if let Err(error) = save_publication(
                            state,
                            &publication,
                            "publication.checks_changed",
                            serde_json::json!({"summary": summary}),
                        )
                        .await
                        {
                            return pause_and_sync(
                                state,
                                requirement_id,
                                run_id,
                                "persist_remote_checks",
                                &error.to_string(),
                                emitter,
                            )
                            .await;
                        }
                        last_wait_summary = Some(summary);
                    }
                    tokio::time::sleep(StdDuration::from_secs(15)).await;
                }
                Ok(RemoteReviewState::ChecksFailed { summary }) => {
                    publication.last_error = Some(summary.clone());
                    publication.updated_at = Utc::now();
                    let _ = save_publication(
                        state,
                        &publication,
                        "publication.checks_failed",
                        serde_json::json!({"summary": summary}),
                    )
                    .await;
                    if publication.remote_ci_fix_used {
                        return pause_and_sync(
                            state,
                            requirement_id,
                            run_id,
                            "remote_ci_failed_after_fix",
                            &summary,
                            emitter,
                        )
                        .await;
                    }
                    publication.remote_ci_fix_used = true;
                    publication.updated_at = Utc::now();
                    if let Err(error) = save_publication(
                        state,
                        &publication,
                        "publication.remote_ci_fix_started",
                        serde_json::json!({"summary": summary}),
                    )
                    .await
                    {
                        return pause_and_sync(
                            state,
                            requirement_id,
                            run_id,
                            "persist_remote_ci_fix",
                            &error.to_string(),
                            emitter,
                        )
                        .await;
                    }
                    if let Err(error) = run_remote_ci_fix(
                        state,
                        run_id,
                        workspace,
                        &mut publication,
                        &summary,
                        emitter,
                    )
                    .await
                    {
                        return pause_and_sync(
                            state,
                            requirement_id,
                            run_id,
                            "remote_ci_fix",
                            &error,
                            emitter,
                        )
                        .await;
                    }
                }
                Ok(RemoteReviewState::Blocked { reason }) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "publication_external_action",
                        &reason,
                        emitter,
                    )
                    .await;
                }
                Err(error) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "publication_poll",
                        &error.to_string(),
                        emitter,
                    )
                    .await;
                }
            }
        }

        if publication.local_sync_status == WorkflowLocalSyncStatus::Pending {
            match sync_local_target_branch(
                workspace,
                &publication.target_branch,
                &workspace.base_head,
            )
            .await
            {
                Ok(commit) => {
                    publication.local_sync_status = WorkflowLocalSyncStatus::Synced;
                    publication.local_sync_message = Some(format!("本地主分支已同步到 {commit}"));
                }
                Err(warning) => {
                    publication.local_sync_status = WorkflowLocalSyncStatus::Skipped;
                    publication.local_sync_message = Some(warning);
                }
            }
            publication.updated_at = Utc::now();
            if let Err(error) = save_publication(
                state,
                &publication,
                "publication.local_sync_finished",
                serde_json::json!({
                    "status": publication.local_sync_status,
                    "message": publication.local_sync_message,
                }),
            )
            .await
            {
                return pause_and_sync(
                    state,
                    requirement_id,
                    run_id,
                    "persist_local_sync",
                    &error.to_string(),
                    emitter,
                )
                .await;
            }
        }
    }

    publication.phase = WorkflowPublicationPhase::Cleaning;
    publication.cleanup_status = WorkflowCleanupStatus::Running;
    publication.updated_at = Utc::now();
    if let Err(error) = save_publication(
        state,
        &publication,
        "publication.cleaning",
        serde_json::json!({}),
    )
    .await
    {
        return pause_and_sync(
            state,
            requirement_id,
            run_id,
            "persist_cleanup_start",
            &error.to_string(),
            emitter,
        )
        .await;
    }
    if publication.mode == WorkflowPublicationMode::PullRequest
        && let Err(error) =
            delete_remote_workflow_branch(&workspace.project_root, &publication.source_branch).await
    {
        publication.cleanup_status = WorkflowCleanupStatus::Failed;
        publication.last_error = Some(error.to_string());
        publication.updated_at = Utc::now();
        let _ = save_publication(
            state,
            &publication,
            "publication.cleanup_failed",
            serde_json::json!({"step": "remote_branch", "error": error.to_string()}),
        )
        .await;
        return pause_and_sync(
            state,
            requirement_id,
            run_id,
            "publication_cleanup",
            &error.to_string(),
            emitter,
        )
        .await;
    }
    if let Err(error) = cleanup_workflow_workspace(workspace).await {
        publication.cleanup_status = WorkflowCleanupStatus::Failed;
        publication.last_error = Some(error.to_string());
        publication.updated_at = Utc::now();
        let _ = save_publication(
            state,
            &publication,
            "publication.cleanup_failed",
            serde_json::json!({"step": "local_workspace", "error": error.to_string()}),
        )
        .await;
        return pause_and_sync(
            state,
            requirement_id,
            run_id,
            "publication_cleanup",
            &error.to_string(),
            emitter,
        )
        .await;
    }
    publication.phase = WorkflowPublicationPhase::Completed;
    publication.cleanup_status = WorkflowCleanupStatus::Completed;
    publication.last_error = None;
    publication.updated_at = Utc::now();
    if let Err(error) = save_publication(
        state,
        &publication,
        "publication.completed",
        serde_json::json!({"final_commit": publication.merge_commit}),
    )
    .await
    {
        return pause_and_sync(
            state,
            requirement_id,
            run_id,
            "persist_cleanup_completion",
            &error.to_string(),
            emitter,
        )
        .await;
    }
    let final_commit = publication
        .merge_commit
        .clone()
        .or_else(|| publication.head_commit.clone())
        .unwrap_or_else(|| workspace.base_head.clone());
    let completed = {
        let store = state.store.read().await;
        store.db.complete_after_integration(
            checkpoint_id,
            &final_commit,
            "发布、同步与受管资源清理已完成",
            accept_all_work_items,
        )
    };
    if let Err(error) = completed {
        return pause_and_sync(
            state,
            requirement_id,
            run_id,
            "persist_completion",
            &error.to_string(),
            emitter,
        )
        .await;
    }
    sync_terminal(state, requirement_id, WorkflowRunStatus::Completed, emitter).await
}

async fn save_publication(
    state: &AppState,
    publication: &crate::workflow::WorkflowPublication,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<(), AppError> {
    let store = state.store.read().await;
    store
        .db
        .save_workflow_publication(publication, event_type, &payload)
}

fn publication_copy(snapshot: &WorkflowSnapshot) -> (String, String) {
    fn bounded(value: &str, max: usize) -> String {
        value.chars().take(max).collect()
    }
    let title = format!("(feat) {}", bounded(&snapshot.run.change_spec.intent, 120));
    let validation = snapshot
        .validations
        .iter()
        .filter(|item| item.gating)
        .take(8)
        .map(|item| format!("- `{}`：{:?}", item.command, item.final_status))
        .collect::<Vec<_>>()
        .join("\n");
    let review = snapshot
        .checkpoints
        .last()
        .and_then(|checkpoint| checkpoint.summary.as_deref())
        .unwrap_or("最终审核已通过");
    let body = format!(
        "# 目标 / 背景\n- {}\n\n# 测试说明\n{}\n\n# 审核\n- {}\n\n# 影响范围\n- WorkflowRun 自动生成；请以远端 diff 为准。\n",
        bounded(&snapshot.run.change_spec.intent, 600),
        if validation.is_empty() {
            "- 未发现可执行的仓库原生 gate".to_owned()
        } else {
            validation
        },
        bounded(review, 300),
    );
    (title, body)
}

async fn run_remote_ci_fix(
    state: &AppState,
    run_id: &str,
    workspace: &crate::workflow::IntegrationWorkspace,
    publication: &mut crate::workflow::WorkflowPublication,
    failure_summary: &str,
    emitter: &RequirementEventEmitter,
) -> Result<(), String> {
    let current = snapshot(state, run_id)
        .await
        .map_err(|error| error.to_string())?;
    let (project, model_settings) = {
        let store = state.store.read().await;
        let project = store.project.clone();
        (
            project,
            store.model_settings().map_err(|error| error.to_string())?,
        )
    };
    {
        let store = state.store.read().await;
        store
            .db
            .transition_workflow_run(run_id, WorkflowRunStatus::Fixing, None)
            .map_err(|error| error.to_string())?;
    }
    let attempt = {
        let store = state.store.read().await;
        store
            .db
            .start_workflow_attempt(run_id, None, WorkflowAttemptKind::RemoteCiFix, "high")
    }
    .map_err(|error| error.to_string())?;
    let result = state
        .model_provider
        .execute_workflow_attempt(
            WorkflowAgentInput {
                project: project.clone(),
                run: current.run.clone(),
                work_item: None,
                attempt_kind: WorkflowAttemptKind::RemoteCiFix,
                model_tier: RequirementModelTier::High,
                working_dir: workspace.worktree.clone(),
                open_blockers: latest_open_blockers(&current),
                recent_failures: current.attempts.clone(),
                validation_evidence: current.validations.clone(),
                model_settings: model_settings.clone(),
                resume_session_file: None,
                continuation_feedback: Some(format!(
                    "远端 CI 明确失败。只修复以下失败，不改变已通过行为：\n{failure_summary}"
                )),
            },
            Some(emitter.clone()),
        )
        .await;
    finish_run_level_attempt(state, &attempt.id, result)
        .await
        .map_err(|error| match error {
            AttemptFailure::Technical(message) | AttemptFailure::Semantic(message) => message,
        })?;

    let planned_scope = current
        .work_items
        .iter()
        .flat_map(|item| item.scope_hints.clone())
        .collect::<Vec<_>>();
    let catalog =
        RepositoryValidationCatalog::discover_for_scope(&workspace.worktree, &planned_scope)
            .map_err(|error| error.to_string())?;
    let decision = validate_and_review(
        state,
        run_id,
        &project,
        &model_settings,
        ReviewPass {
            workspace,
            catalog: &catalog,
            kind: CheckpointKind::Final,
            repair_security_recheck: true,
        },
        emitter,
    )
    .await?;
    if !matches!(decision, FinalDecision::Approved(_)) {
        return Err(match decision {
            FinalDecision::ValidationFailure(reason) | FinalDecision::ReviewFailure(reason) => {
                reason
            }
            FinalDecision::Approved(_) => unreachable!(),
        });
    }
    let commit = commit_integration_checkpoint(&workspace.worktree, "修复远端 CI")
        .await
        .map_err(|error| error.to_string())?;
    let pushed_head = push_workflow_branch(workspace)
        .await
        .map_err(|error| error.to_string())?;
    if pushed_head != commit {
        return Err("远端 CI 修复提交与推送 head 不一致".to_owned());
    }
    publication.head_commit = Some(commit);
    publication.phase = WorkflowPublicationPhase::ReviewOpen;
    publication.last_error = None;
    publication.updated_at = Utc::now();
    save_publication(
        state,
        publication,
        "publication.remote_ci_fix_pushed",
        serde_json::json!({"head_commit": publication.head_commit}),
    )
    .await
    .map_err(|error| error.to_string())?;
    arm_remote_auto_merge(workspace, publication)
        .await
        .map_err(|error| error.to_string())?;
    publication.phase = WorkflowPublicationPhase::WaitingChecks;
    publication.updated_at = Utc::now();
    save_publication(
        state,
        publication,
        "publication.waiting_checks",
        serde_json::json!({"after_remote_ci_fix": true}),
    )
    .await
    .map_err(|error| error.to_string())?;
    {
        let store = state.store.read().await;
        store
            .db
            .transition_workflow_run(run_id, WorkflowRunStatus::Publishing, None)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_rescue_feedback(
    state: &AppState,
    run_id: &str,
    project: &crate::models::Project,
    model_settings: &crate::models::ModelSettings,
    workspace: &crate::workflow::IntegrationWorkspace,
    session_file: Option<&str>,
    validation_failure: &str,
    catalog: &RepositoryValidationCatalog,
    emitter: &RequirementEventEmitter,
) -> Result<FinalDecision, String> {
    let session_file = session_file
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Rescue 未返回可恢复的 Pi 会话".to_owned())?;
    let current = snapshot(state, run_id)
        .await
        .map_err(|error| error.to_string())?;
    let feedback = rescue_validation_feedback(&current.validations, validation_failure);
    {
        let store = state.store.read().await;
        store
            .db
            .transition_workflow_run(run_id, WorkflowRunStatus::Rescuing, None)
            .map_err(|error| error.to_string())?;
    }
    let attempt = {
        let store = state.store.read().await;
        store
            .db
            .start_workflow_attempt(run_id, None, WorkflowAttemptKind::Rescue, "high")
    }
    .map_err(|error| error.to_string())?;
    let before_diff = staged_integration_diff(&workspace.worktree)
        .await
        .map_err(|error| error.to_string())?;
    let result = state
        .model_provider
        .execute_workflow_attempt(
            WorkflowAgentInput {
                project: project.clone(),
                run: current.run.clone(),
                work_item: None,
                attempt_kind: WorkflowAttemptKind::Rescue,
                model_tier: RequirementModelTier::High,
                working_dir: workspace.worktree.clone(),
                open_blockers: latest_open_blockers(&current),
                recent_failures: current.attempts.clone(),
                validation_evidence: current.validations.clone(),
                model_settings: model_settings.clone(),
                resume_session_file: Some(session_file),
                continuation_feedback: Some(feedback),
            },
            Some(emitter.clone()),
        )
        .await;
    match finish_run_level_attempt(state, &attempt.id, result).await {
        Ok(_) => {}
        Err(AttemptFailure::Technical(error)) => return Err(error),
        Err(AttemptFailure::Semantic(error)) => {
            return Ok(FinalDecision::ReviewFailure(error));
        }
    }
    stage_integration_changes(&workspace.worktree)
        .await
        .map_err(|error| error.to_string())?;
    let after_diff = staged_integration_diff(&workspace.worktree)
        .await
        .map_err(|error| error.to_string())?;
    validate_and_review(
        state,
        run_id,
        project,
        model_settings,
        ReviewPass {
            workspace,
            catalog,
            kind: CheckpointKind::Rescue,
            repair_security_recheck: repair_diff_triggers_security(&before_diff, &after_diff),
        },
        emitter,
    )
    .await
}

fn rescue_validation_feedback(
    validations: &[WorkflowValidation],
    validation_failure: &str,
) -> String {
    let evidence = validations
        .iter()
        .filter(|validation| {
            validation.gating
                && validation.baseline_status == ValidationRunStatus::Passed
                && validation.final_status == ValidationRunStatus::Failed
        })
        .map(|validation| {
            serde_json::json!({
                "command": validation.command,
                "baseline_status": validation.baseline_status,
                "final_status": validation.final_status,
                "exit_code": validation.final_exit_code,
                "summary": validation.output_summary,
            })
        })
        .collect::<Vec<_>>();
    format!(
        "{validation_failure}\n{}",
        serde_json::to_string(&evidence).expect("validation evidence serializes")
    )
}

fn review_angles_for_checkpoint(
    snapshot: &WorkflowSnapshot,
    paths: &[String],
    diff: &str,
    repair_security_recheck: bool,
) -> Vec<ReviewAngle> {
    if let Some(checkpoint) = snapshot
        .checkpoints
        .last()
        .filter(|checkpoint| checkpoint.status == CheckpointStatus::TechnicalFailure)
    {
        let retry_angles = checkpoint
            .review_details
            .as_ref()
            .into_iter()
            .flat_map(|details| &details.reviews)
            .filter(|review| review.transport_status != ReviewTransportStatus::Completed)
            .map(|review| review.angle)
            .collect::<Vec<_>>();
        if !retry_angles.is_empty() {
            return ordered_unique_angles(retry_angles);
        }
        return checkpoint.required_angles.clone();
    }

    let has_semantic_review = snapshot.checkpoints.iter().any(|checkpoint| {
        matches!(
            checkpoint.status,
            CheckpointStatus::Approved | CheckpointStatus::Rejected
        )
    });
    if !has_semantic_review {
        return required_review_angles_for_diff(paths, diff);
    }

    let mut angles = vec![ReviewAngle::Correctness];
    angles.extend(
        snapshot
            .findings
            .iter()
            .filter(|finding| {
                finding.status == FindingStatus::Open && finding.priority.is_blocking()
            })
            .map(|finding| finding.angle),
    );
    if repair_security_recheck {
        angles.push(ReviewAngle::Security);
    }
    ordered_unique_angles(angles)
}

fn ordered_unique_angles(angles: Vec<ReviewAngle>) -> Vec<ReviewAngle> {
    [
        ReviewAngle::Correctness,
        ReviewAngle::Quality,
        ReviewAngle::Security,
    ]
    .into_iter()
    .filter(|candidate| angles.contains(candidate))
    .collect()
}

fn repair_diff_triggers_security(before: &str, after: &str) -> bool {
    if before == after {
        return false;
    }
    let before_sections = diff_sections(before);
    let after_sections = diff_sections(after);
    let changed = after_sections
        .iter()
        .filter(|(path, section)| before_sections.get(*path) != Some(*section))
        .map(|(path, section)| (path.clone(), section.clone()))
        .collect::<BTreeMap<_, _>>();
    let changed_diff = if changed.is_empty() {
        after.to_owned()
    } else {
        changed.values().cloned().collect::<Vec<_>>().join("\n")
    };
    let changed_paths = changed.keys().cloned().collect::<Vec<_>>();
    required_review_angles_for_diff(&changed_paths, &changed_diff).contains(&ReviewAngle::Security)
}

fn diff_sections(diff: &str) -> BTreeMap<String, String> {
    let mut sections = BTreeMap::new();
    let mut current_path: Option<String> = None;
    let mut current = String::new();
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git a/") {
            if let Some(path) = current_path.take() {
                sections.insert(path, std::mem::take(&mut current));
            }
            current_path = rest.split_once(" b/").map(|(_, path)| path.to_owned());
        }
        if current_path.is_some() {
            current.push_str(line);
            current.push('\n');
        }
    }
    if let Some(path) = current_path {
        sections.insert(path, current);
    }
    sections
}

fn has_integration_fix(snapshot: &WorkflowSnapshot) -> bool {
    snapshot.attempts.iter().any(|attempt| {
        attempt.kind == WorkflowAttemptKind::IntegrationFix
            && (attempt.status == WorkflowAttemptStatus::Succeeded
                || (attempt.status == WorkflowAttemptStatus::Failed
                    && attempt
                        .failure_class
                        .is_some_and(|class| !class.is_technical())))
    })
}

fn diff_paths(diff: &str) -> Vec<String> {
    diff.lines()
        .filter_map(|line| line.strip_prefix("diff --git a/"))
        .filter_map(|line| line.split_once(" b/").map(|(_, path)| path.to_owned()))
        .collect()
}

fn completed_review_angles(details: Option<&ReviewReport>) -> Vec<ReviewAngle> {
    let angles = details
        .into_iter()
        .flat_map(|details| &details.reviews)
        .filter(|review| review.transport_status == ReviewTransportStatus::Completed)
        .map(|review| review.angle)
        .collect::<Vec<_>>();
    ordered_unique_angles(angles)
}

fn classify_error(error: &AppError) -> FailureClass {
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("协议") || message.contains("结构化") || message.contains("schema") {
        FailureClass::ModelProtocol
    } else if message.contains("git") || message.contains("worktree") {
        FailureClass::GitConflict
    } else if message.contains("验证") || message.contains("test") || message.contains("check") {
        FailureClass::Validation
    } else if message.contains("agent") || message.contains("pi ") || message.contains("rpc") {
        FailureClass::AgentRuntime
    } else {
        FailureClass::Infrastructure
    }
}

fn tier_label(tier: RequirementModelTier) -> &'static str {
    match tier {
        RequirementModelTier::Low => "low",
        RequirementModelTier::Medium => "medium",
        RequirementModelTier::High => "high",
    }
}

async fn snapshot(state: &AppState, run_id: &str) -> Result<WorkflowSnapshot, AppError> {
    let store = state.store.read().await;
    store.db.workflow_snapshot(run_id)
}

async fn pause_and_sync(
    state: &AppState,
    requirement_id: &str,
    run_id: &str,
    operation: &str,
    reason: &str,
    emitter: &RequirementEventEmitter,
) -> RequirementStatus {
    let result = {
        let store = state.store.read().await;
        store.db.pause_workflow_run(run_id, operation, reason)
    };
    if let Err(error) = result {
        tracing::error!(run_id, %error, "failed to pause technical WorkflowRun");
    }
    emitter.emit(
        "workflow_paused_technical",
        &format!("技术暂停（{operation}）：{reason}"),
    );
    let mut store = state.store.write().await;
    let _ = store
        .finish_requirement_from_workflow(
            requirement_id,
            WorkflowRunStatus::PausedTechnical,
            Some(reason),
        )
        .await;
    RequirementStatus::Running
}

async fn block_and_sync(
    state: &AppState,
    requirement_id: &str,
    run_id: &str,
    reason: &str,
    emitter: &RequirementEventEmitter,
) -> RequirementStatus {
    {
        let store = state.store.read().await;
        if let Err(error) = store.db.block_workflow_run(run_id, reason) {
            tracing::error!(run_id, %error, "failed to block WorkflowRun");
        }
    }
    emitter.emit("workflow_blocked", reason);
    sync_terminal(state, requirement_id, WorkflowRunStatus::Blocked, emitter).await
}

async fn sync_terminal(
    state: &AppState,
    requirement_id: &str,
    status: WorkflowRunStatus,
    emitter: &RequirementEventEmitter,
) -> RequirementStatus {
    let message = match status {
        WorkflowRunStatus::Completed => "WorkflowRun 已完成。",
        WorkflowRunStatus::Blocked => "WorkflowRun 已阻塞。",
        WorkflowRunStatus::Cancelled => "WorkflowRun 已取消。",
        _ => "WorkflowRun 仍在运行。",
    };
    let result = {
        let mut store = state.store.write().await;
        store
            .finish_requirement_from_workflow(requirement_id, status, Some(message))
            .await
    };
    match result {
        Ok(requirement_status) => {
            if requirement_status == RequirementStatus::Completed {
                emitter.emit("workflow_completed", message);
            }
            requirement_status
        }
        Err(error) => {
            tracing::error!(requirement_id, %error, "failed to sync terminal WorkflowRun");
            RequirementStatus::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_p0_and_p1_are_blocking() {
        assert!(crate::workflow::FindingPriority::P0.is_blocking());
        assert!(crate::workflow::FindingPriority::P1.is_blocking());
        assert!(!crate::workflow::FindingPriority::P2.is_blocking());
        assert!(!crate::workflow::FindingPriority::P3.is_blocking());
    }

    #[test]
    fn diff_path_extraction_uses_final_git_headers() {
        assert_eq!(
            diff_paths("diff --git a/src/lib.rs b/src/lib.rs\n+x"),
            ["src/lib.rs"]
        );
    }

    #[test]
    fn repair_security_detection_only_uses_sections_changed_by_the_repair() {
        let before = concat!(
            "diff --git a/src/auth.rs b/src/auth.rs\n+old auth\n",
            "diff --git a/src/ui.rs b/src/ui.rs\n+old ui\n",
        );
        let ui_only = concat!(
            "diff --git a/src/auth.rs b/src/auth.rs\n+old auth\n",
            "diff --git a/src/ui.rs b/src/ui.rs\n+new ui\n",
        );
        let auth_changed = concat!(
            "diff --git a/src/auth.rs b/src/auth.rs\n+Command::new(\"git\")\n",
            "diff --git a/src/ui.rs b/src/ui.rs\n+old ui\n",
        );
        assert!(!repair_diff_triggers_security(before, ui_only));
        assert!(repair_diff_triggers_security(before, auth_changed));
    }

    #[test]
    fn completed_review_angles_ignore_failed_transports() {
        let details = serde_json::json!({
            "selection": {
                "classification": "source",
                "angles": ["正确性", "边界与安全"],
                "skippedAngles": [],
                "reasons": [],
                "focus": "",
                "fileCount": 1,
                "changedLines": 1,
                "diffBytes": 1
            },
            "reviews": [
                {"angle": "正确性", "transport_status": "completed"},
                {"angle": "边界与安全", "transport_status": "failed"}
            ]
        });
        let report = ReviewReport::from_details(&details).unwrap();
        assert_eq!(
            completed_review_angles(Some(&report)),
            [ReviewAngle::Correctness]
        );
    }
}
