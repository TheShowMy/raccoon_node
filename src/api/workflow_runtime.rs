use std::{collections::BTreeMap, path::Path};

use chrono::{Duration, Utc};

use crate::api::AppState;
use crate::error::AppError;
use crate::models::{RequirementEventEmitter, RequirementModelTier, RequirementStatus};
use crate::workflow::{
    CheckpointKind, CheckpointStatus, FailureClass, FindingStatus, RepositoryValidationCatalog,
    ReviewAngle, ValidationRunStatus, ValidationSource, WORK_ITEM_LEASE_SECONDS,
    WorkflowAgentInput, WorkflowAttemptKind, WorkflowAttemptStatus, WorkflowReviewInput,
    WorkflowRunStatus, WorkflowSnapshot, WorkflowValidation, all_work_items_accepted,
    commit_integration_checkpoint, execute_catalog_command, integrate_workflow_branch,
    latest_open_blockers, new_workflow_id, next_attempt_policy, prepare_integration_workspace,
    required_review_angles_for_diff, stage_integration_changes, staged_integration_diff,
    worktree_fingerprint,
};

pub async fn run_workflow_execution_v5(
    state: AppState,
    requirement_id: String,
    run_id: String,
) -> RequirementStatus {
    let emitter = RequirementEventEmitter {
        requirement_id: requirement_id.clone(),
        task_id: None,
        bus: state.requirement_events.clone(),
    };
    emitter.emit("workflow_started", "WorkflowRun v5 开始执行行为切片。");

    let (project, model_settings, data_root) = {
        let store = state.store.read().await;
        let Some(project) = store
            .data
            .projects
            .iter()
            .find(|project| project.id == "current")
            .cloned()
        else {
            return pause_and_sync(
                &state,
                &requirement_id,
                &run_id,
                "load_project",
                "当前项目不存在",
                &emitter,
            )
            .await;
        };
        (
            project,
            store.data.model_settings.clone(),
            store.data_root.clone(),
        )
    };

    let workspace =
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
        if snapshot
            .run
            .paused_operation
            .as_deref()
            .is_some_and(|operation| {
                matches!(
                    operation,
                    "commit_integration"
                        | "fast_forward_integration"
                        | "persist_completion"
                        | "rescue_commit"
                        | "rescue_integration"
                        | "persist_rescue_completion"
                )
            })
            && let Some(checkpoint) = snapshot
                .checkpoints
                .iter()
                .rev()
                .find(|checkpoint| checkpoint.status == CheckpointStatus::Approved)
        {
            let rescue = snapshot
                .run
                .paused_operation
                .as_deref()
                .is_some_and(|operation| operation.starts_with("rescue_"));
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
            match execute_next_work_item(
                &state,
                &project,
                &model_settings,
                &workspace.worktree,
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
                    return pause_and_sync(
                        &state,
                        &requirement_id,
                        &run_id,
                        "work_item_attempt",
                        &technical,
                        &emitter,
                    )
                    .await;
                }
            }
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
                    match commit_integration_checkpoint(&workspace.worktree, "完成 WorkflowRun v5")
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
                let final_commit = match integrate_workflow_branch(&workspace).await {
                    Ok(commit) => commit,
                    Err(error) => {
                        return pause_and_sync(
                            &state,
                            &requirement_id,
                            &run_id,
                            "fast_forward_integration",
                            &error.to_string(),
                            &emitter,
                        )
                        .await;
                    }
                };
                let stored = {
                    let store = state.store.read().await;
                    store.db.complete_after_integration(
                        &checkpoint_id,
                        &final_commit,
                        &format!("最终审核通过；integration commit {commit}"),
                        false,
                    )
                };
                if let Err(error) = stored {
                    return pause_and_sync(
                        &state,
                        &requirement_id,
                        &run_id,
                        "persist_completion",
                        &error.to_string(),
                        &emitter,
                    )
                    .await;
                }
                return sync_terminal(
                    &state,
                    &requirement_id,
                    WorkflowRunStatus::Completed,
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

enum WorkItemOutcome {
    Continue,
    SemanticExhausted(String),
}

async fn execute_next_work_item(
    state: &AppState,
    project: &crate::models::Project,
    model_settings: &crate::models::ModelSettings,
    working_dir: &Path,
    snapshot: &WorkflowSnapshot,
    emitter: &RequirementEventEmitter,
) -> Result<WorkItemOutcome, String> {
    let item = snapshot
        .work_items
        .iter()
        .find(|item| item.status == crate::workflow::WorkItemStatus::Blocked)
        .cloned();
    let item = if let Some(item) = item {
        if next_attempt_policy(&item).is_none() {
            return Ok(WorkItemOutcome::SemanticExhausted(format!(
                "工作项在低档实现、低档修复和高档修复后仍失败：{}",
                item.objective
            )));
        }
        {
            let store = state.store.read().await;
            store.db.prepare_work_item_fix(&item.id)
        }
        .map_err(|error| error.to_string())?;
        claim_one(state, &snapshot.run.id).await?
    } else {
        claim_one(state, &snapshot.run.id).await?
    };
    let Some(policy) = next_attempt_policy(&item) else {
        return Ok(WorkItemOutcome::SemanticExhausted(format!(
            "工作项尝试次数已耗尽：{}",
            item.objective
        )));
    };
    let worker_id = format!("workflow-v5:{}", snapshot.run.id);
    let attempt = {
        let store = state.store.read().await;
        store.db.start_workflow_attempt(
            &snapshot.run.id,
            Some(&item.id),
            policy.kind,
            tier_label(policy.model_tier),
            &worker_id,
        )
    }
    .map_err(|error| error.to_string())?;
    emitter.emit(
        "work_item_attempt_started",
        &format!("开始交付：{}（第 {} 次）", item.objective, attempt.ordinal),
    );
    let input = WorkflowAgentInput {
        project: project.clone(),
        run: snapshot.run.clone(),
        work_item: Some(item.clone()),
        attempt_kind: policy.kind,
        model_tier: policy.model_tier,
        working_dir: working_dir.to_path_buf(),
        open_blockers: latest_open_blockers(snapshot),
        recent_failures: snapshot.attempts.clone(),
        validation_evidence: snapshot.validations.clone(),
        model_settings: model_settings.clone(),
        resume_session_file: None,
        continuation_feedback: None,
    };
    match state
        .model_provider
        .execute_workflow_attempt(input, Some(emitter.clone()))
        .await
    {
        Ok(output) if output.completed => {
            let store = state.store.read().await;
            store
                .db
                .finish_workflow_attempt(
                    &attempt.id,
                    true,
                    output.pi_session_file.as_deref(),
                    output.worktree_fingerprint.as_deref(),
                    Some(&output.result_summary),
                    None,
                    None,
                    output.usage.as_ref(),
                )
                .map_err(|error| error.to_string())?;
            emitter.emit(
                "work_item_completed",
                &format!("已交付：{}", item.objective),
            );
            Ok(WorkItemOutcome::Continue)
        }
        Ok(output) => {
            let store = state.store.read().await;
            store
                .db
                .finish_workflow_attempt(
                    &attempt.id,
                    false,
                    output.pi_session_file.as_deref(),
                    output.worktree_fingerprint.as_deref(),
                    Some(&output.result_summary),
                    Some(FailureClass::BehaviourConflict),
                    Some(&output.result_summary),
                    output.usage.as_ref(),
                )
                .map_err(|error| error.to_string())?;
            if item.attempt_count + 1 >= 3 {
                Ok(WorkItemOutcome::SemanticExhausted(output.result_summary))
            } else {
                Ok(WorkItemOutcome::Continue)
            }
        }
        Err(error) => {
            let class = classify_error(&error);
            let store_result = {
                let store = state.store.read().await;
                store.db.finish_workflow_attempt(
                    &attempt.id,
                    false,
                    None,
                    None,
                    None,
                    Some(class),
                    Some(&error.to_string()),
                    error.trace(),
                )
            };
            store_result.map_err(|save| save.to_string())?;
            if class.is_technical() {
                Err(error.to_string())
            } else if item.attempt_count + 1 >= 3 {
                Ok(WorkItemOutcome::SemanticExhausted(error.to_string()))
            } else {
                Ok(WorkItemOutcome::Continue)
            }
        }
    }
}

async fn claim_one(state: &AppState, run_id: &str) -> Result<crate::workflow::WorkItem, String> {
    let worker_id = format!("workflow-v5:{run_id}");
    let items = {
        let store = state.store.read().await;
        store.db.claim_runnable_work_items(
            run_id,
            &worker_id,
            Utc::now() + Duration::seconds(WORK_ITEM_LEASE_SECONDS),
            1,
        )
    }
    .map_err(|error| error.to_string())?;
    items
        .into_iter()
        .next()
        .ok_or_else(|| "没有满足依赖的可运行工作项".to_owned())
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
            "workflow-v5-integration-fix",
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
            let commit =
                match commit_integration_checkpoint(&workspace.worktree, "Rescue WorkflowRun v5")
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
            let final_commit = match integrate_workflow_branch(workspace).await {
                Ok(commit) => commit,
                Err(error) => {
                    return pause_and_sync(
                        state,
                        requirement_id,
                        run_id,
                        "rescue_integration",
                        &error.to_string(),
                        emitter,
                    )
                    .await;
                }
            };
            let completed = {
                let store = state.store.read().await;
                store.db.complete_after_integration(
                    &checkpoint_id,
                    &final_commit,
                    &format!("Rescue 审核通过；integration commit {commit}"),
                    true,
                )
            };
            if let Err(error) = completed {
                return pause_and_sync(
                    state,
                    requirement_id,
                    run_id,
                    "persist_rescue_completion",
                    &error.to_string(),
                    emitter,
                )
                .await;
            }
            sync_terminal(state, requirement_id, WorkflowRunStatus::Completed, emitter).await
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
        "Rescue WorkflowRun v5"
    } else {
        "完成 WorkflowRun v5"
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
    let final_commit = match integrate_workflow_branch(workspace).await {
        Ok(commit) => commit,
        Err(error) => {
            return pause_and_sync(
                state,
                requirement_id,
                run_id,
                if rescue {
                    "rescue_integration"
                } else {
                    "fast_forward_integration"
                },
                &error.to_string(),
                emitter,
            )
            .await;
        }
    };
    let completed = {
        let store = state.store.read().await;
        store.db.complete_after_integration(
            checkpoint_id,
            &final_commit,
            &format!("恢复终端集成步骤；integration commit {commit}"),
            rescue,
        )
    };
    if let Err(error) = completed {
        return pause_and_sync(
            state,
            requirement_id,
            run_id,
            if rescue {
                "persist_rescue_completion"
            } else {
                "persist_completion"
            },
            &error.to_string(),
            emitter,
        )
        .await;
    }
    sync_terminal(state, requirement_id, WorkflowRunStatus::Completed, emitter).await
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
        store.db.start_workflow_attempt(
            run_id,
            None,
            WorkflowAttemptKind::Rescue,
            "high",
            "workflow-v5-rescue-feedback",
        )
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
            .and_then(|details| details.get("reviews"))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter(|review| {
                review
                    .get("transport_status")
                    .and_then(serde_json::Value::as_str)
                    != Some("completed")
            })
            .filter_map(|review| review.get("angle").and_then(serde_json::Value::as_str))
            .filter_map(crate::workflow::parse_review_angle)
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

fn completed_review_angles(details: Option<&serde_json::Value>) -> Vec<ReviewAngle> {
    let angles = details
        .and_then(|value| value.get("reviews"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|review| {
            review
                .get("transport_status")
                .and_then(serde_json::Value::as_str)
                == Some("completed")
        })
        .filter_map(|review| review.get("angle").and_then(serde_json::Value::as_str))
        .filter_map(crate::workflow::parse_review_angle)
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
        WorkflowRunStatus::Completed => "WorkflowRun v5 已完成。",
        WorkflowRunStatus::Blocked => "WorkflowRun v5 已阻塞。",
        WorkflowRunStatus::Cancelled => "WorkflowRun v5 已取消。",
        _ => "WorkflowRun v5 仍在运行。",
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
            "reviews": [
                {"angle": "正确性", "transport_status": "completed"},
                {"angle": "边界与安全", "transport_status": "failed"}
            ]
        });
        assert_eq!(
            completed_review_angles(Some(&details)),
            [ReviewAngle::Correctness]
        );
    }
}
