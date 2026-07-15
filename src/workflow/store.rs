use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::error::AppError;
use crate::store::db::Database;

use super::{
    CheckpointKind, CheckpointStatus, CompiledWorkflow, CompletedWorkflowWorkspace, FailureClass,
    FindingStatus, OperationMetrics, PausedOperation, ReviewAngle, ReviewReport,
    ReviewTransportStatus, WorkItem, WorkItemDependency, WorkflowAttempt, WorkflowAttemptKind,
    WorkflowAttemptStatus, WorkflowCheckpoint, WorkflowEvent, WorkflowEventPage,
    WorkflowItemWorkspace, WorkflowPublication, WorkflowReviewFinding, WorkflowRun,
    WorkflowRunStatus, WorkflowSnapshot, WorkflowValidation, new_workflow_id,
};

const DEFAULT_EVENT_LIMIT: usize = 100;
const MAX_EVENT_LIMIT: usize = 500;

impl Database {
    pub fn completed_workflow_workspaces(
        &self,
    ) -> Result<Vec<CompletedWorkflowWorkspace>, AppError> {
        let conn = self.lock_connection();
        let mut statement = conn.prepare(
            "SELECT id, integration_worktree, integration_branch, base_head, final_commit
             FROM workflow_runs
             WHERE status = 'completed' AND integration_worktree IS NOT NULL
               AND integration_branch IS NOT NULL AND base_head IS NOT NULL
               AND final_commit IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM workflow_publications publication
                 WHERE publication.run_id = workflow_runs.id
                   AND publication.cleanup_status = 'completed'
               )",
        )?;
        Ok(statement
            .query_map([], |row| {
                Ok(CompletedWorkflowWorkspace {
                    run_id: row.get(0)?,
                    worktree_path: row.get(1)?,
                    branch: row.get(2)?,
                    base_head: row.get(3)?,
                    final_commit: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn record_workflow_event(
        &self,
        run_id: &str,
        event_type: &str,
        payload: &Value,
    ) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        append_event_tx(&tx, run_id, "run", run_id, event_type, payload)?;
        tx.commit()?;
        Ok(())
    }

    pub fn record_workflow_failure_fuse(
        &self,
        run_id: &str,
        work_item_id: &str,
        failure_class: FailureClass,
        integration_fingerprint: &str,
    ) -> Result<(), AppError> {
        let conn = self.lock_connection();
        conn.execute(
            "INSERT OR IGNORE INTO workflow_failure_fuses (
                run_id, work_item_id, failure_class, integration_fingerprint, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                run_id,
                work_item_id,
                to_json_string(&failure_class)?,
                integration_fingerprint,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn workflow_failure_fuse(
        &self,
        work_item_id: &str,
        integration_fingerprint: &str,
    ) -> Result<Option<FailureClass>, AppError> {
        let conn = self.lock_connection();
        conn.query_row(
            "SELECT failure_class FROM workflow_failure_fuses
             WHERE work_item_id = ?1 AND integration_fingerprint = ?2
             ORDER BY created_at DESC LIMIT 1",
            params![work_item_id, integration_fingerprint],
            |row| parse_json_column::<FailureClass>(row, 0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn mark_completed_workspace_cleaned(&self, run_id: &str) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE workflow_runs SET integration_worktree = NULL, updated_at = ?2
             WHERE id = ?1 AND status = 'completed'",
            params![run_id, Utc::now().to_rfc3339()],
        )?;
        append_event_tx(
            &tx,
            run_id,
            "run",
            run_id,
            "run.completed_workspace_cleaned",
            &json!({}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn workflow_session_files(&self) -> Result<Vec<String>, AppError> {
        let conn = self.lock_connection();
        let mut statement = conn.prepare(
            "SELECT DISTINCT pi_session_file FROM workflow_attempts
             WHERE pi_session_file IS NOT NULL AND pi_session_file <> ''",
        )?;
        Ok(statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn recover_interrupted_workflows(&self) -> Result<Vec<String>, AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let run_ids = {
            let mut statement = tx.prepare(
                "SELECT DISTINCT run_id FROM workflow_attempts WHERE status = 'running'
                 UNION SELECT run_id FROM workflow_checkpoints WHERE status = 'reviewing'
                 UNION SELECT id FROM workflow_runs
                       WHERE status IN ('planning','running','validating','reviewing','fixing','rescuing','publishing')",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let now = Utc::now().to_rfc3339();
        for run_id in &run_ids {
            tx.execute(
                "UPDATE workflow_work_items
                 SET attempt_count = MAX(attempt_count - 1, 0), updated_at = ?2
                 WHERE run_id = ?1 AND id IN (
                    SELECT work_item_id FROM workflow_attempts
                    WHERE run_id = ?1 AND status = 'running' AND work_item_id IS NOT NULL
                 )",
                params![run_id, now],
            )?;
            tx.execute(
                "UPDATE workflow_attempts
                 SET status = 'failed', failure_class = 'infrastructure',
                     failure_message = 'Raccoon 重启时中断', completed_at = ?2
                 WHERE run_id = ?1 AND status = 'running'",
                params![run_id, now],
            )?;
            tx.execute(
                "UPDATE workflow_runs SET rescue_used = 0, rescue_attempt_id = NULL
                 WHERE id = ?1 AND rescue_used = 1 AND NOT EXISTS (
                    SELECT 1 FROM workflow_attempts
                    WHERE run_id = ?1 AND kind = 'rescue' AND status = 'succeeded'
                 )",
                [run_id],
            )?;
            tx.execute(
                "UPDATE workflow_checkpoints
                 SET status = 'technical_failure', summary = 'Raccoon 重启时审核中断',
                     updated_at = ?2, completed_at = ?2
                 WHERE run_id = ?1 AND status = 'reviewing'",
                params![run_id, now],
            )?;
            tx.execute(
                "UPDATE workflow_work_items
                 SET status = CASE WHEN status = 'running' THEN 'pending' ELSE status END,
                     updated_at = ?2
                 WHERE run_id = ?1",
                params![run_id, now],
            )?;
            tx.execute(
                "UPDATE workflow_runs
                 SET status = 'paused_technical', paused_operation = 'process_restart',
                     blocked_reason = '进程重启中断了活动 operation', updated_at = ?2
                 WHERE id = ?1 AND status NOT IN ('completed','blocked','cancelled')",
                params![run_id, now],
            )?;
            append_event_tx(
                &tx,
                run_id,
                "run",
                run_id,
                "run.paused_technical",
                &json!({"operation": "process_restart", "reason": "进程重启中断了活动 operation"}),
            )?;
        }
        tx.commit()?;
        Ok(run_ids)
    }

    pub fn create_workflow(&self, workflow: &CompiledWorkflow) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        insert_run(&tx, &workflow.run)?;
        for item in &workflow.work_items {
            insert_work_item(&tx, item)?;
        }
        for dependency in &workflow.dependencies {
            tx.execute(
                "INSERT INTO workflow_dependencies (work_item_id, depends_on_id) VALUES (?1, ?2)",
                params![dependency.work_item_id, dependency.depends_on_id],
            )?;
        }
        append_event_tx(
            &tx,
            &workflow.run.id,
            "run",
            &workflow.run.id,
            "run.created",
            &json!({
                "work_item_count": workflow.work_items.len(),
                "scenario_count": workflow.run.change_spec.acceptance_scenarios.len(),
            }),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn restart_workflow_clean(
        &self,
        old_run_id: &str,
        workflow: &CompiledWorkflow,
    ) -> Result<String, AppError> {
        if workflow.run.replaces_run_id.as_deref() != Some(old_run_id) {
            return Err(AppError::bad_request(
                "replacement WorkflowRun 缺少正确的 replaces_run_id",
            ));
        }
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        if let Some(existing) = tx
            .query_row(
                "SELECT id FROM workflow_runs WHERE replaces_run_id = ?1",
                [old_run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(existing);
        }
        let old_status = tx
            .query_row(
                "SELECT status FROM workflow_runs WHERE id = ?1",
                [old_run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::not_found("WorkflowRun 不存在"))?;
        if old_status != to_json_string(&WorkflowRunStatus::PausedTechnical)? {
            return Err(AppError::conflict(
                "只有 paused_technical WorkflowRun 可以从干净工作区重建",
            ));
        }
        let publication_started = tx
            .query_row(
                "SELECT CASE WHEN phase <> 'prepared' OR review_url IS NOT NULL
                     OR head_commit IS NOT NULL OR merge_commit IS NOT NULL THEN 1 ELSE 0 END
                 FROM workflow_publications WHERE run_id = ?1",
                [old_run_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            != 0;
        if publication_started {
            return Err(AppError::conflict(
                "WorkflowRun 已进入远端发布流程，不能从干净工作区重建",
            ));
        }
        let running_attempts = tx.query_row(
            "SELECT COUNT(*) FROM workflow_attempts WHERE run_id = ?1 AND status = 'running'",
            [old_run_id],
            |row| row.get::<_, i64>(0),
        )?;
        if running_attempts != 0 {
            return Err(AppError::conflict(
                "WorkflowRun 仍有活动 Agent 调用，不能从干净工作区重建",
            ));
        }

        let now = Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE workflow_runs SET status = 'cancelled',
                 blocked_reason = '已从干净工作区创建 replacement WorkflowRun',
                 paused_operation = NULL, completed_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![old_run_id, now],
        )?;
        append_event_tx(
            &tx,
            old_run_id,
            "run",
            old_run_id,
            "run.discarded",
            &json!({"replacement_run_id": workflow.run.id}),
        )?;

        insert_run(&tx, &workflow.run)?;
        for item in &workflow.work_items {
            insert_work_item(&tx, item)?;
        }
        for dependency in &workflow.dependencies {
            tx.execute(
                "INSERT INTO workflow_dependencies (work_item_id, depends_on_id) VALUES (?1, ?2)",
                params![dependency.work_item_id, dependency.depends_on_id],
            )?;
        }
        append_event_tx(
            &tx,
            &workflow.run.id,
            "run",
            &workflow.run.id,
            "run.restarted_clean",
            &json!({"replaces_run_id": old_run_id}),
        )?;
        tx.commit()?;
        Ok(workflow.run.id.clone())
    }

    pub fn workflow_snapshot(&self, run_id: &str) -> Result<WorkflowSnapshot, AppError> {
        let conn = self.lock_connection();
        load_snapshot(&conn, run_id)
    }

    pub fn active_workflow_for_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Option<WorkflowSnapshot>, AppError> {
        let conn = self.lock_connection();
        let run_id = conn
            .query_row(
                "SELECT id FROM workflow_runs WHERE requirement_id = ?1
                 ORDER BY created_at DESC LIMIT 1",
                [requirement_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        run_id.map(|id| load_snapshot(&conn, &id)).transpose()
    }

    pub fn replacement_workflow_for(
        &self,
        run_id: &str,
    ) -> Result<Option<WorkflowSnapshot>, AppError> {
        let conn = self.lock_connection();
        let replacement_id = conn
            .query_row(
                "SELECT id FROM workflow_runs WHERE replaces_run_id = ?1",
                [run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        replacement_id
            .map(|replacement_id| load_snapshot(&conn, &replacement_id))
            .transpose()
    }

    pub fn workflow_events(
        &self,
        run_id: &str,
        after: i64,
        limit: Option<usize>,
    ) -> Result<WorkflowEventPage, AppError> {
        let conn = self.lock_connection();
        let limit = limit
            .unwrap_or(DEFAULT_EVENT_LIMIT)
            .clamp(1, MAX_EVENT_LIMIT);
        let mut statement = conn.prepare(
            "SELECT sequence, run_id, entity_type, entity_id, event_type, payload, created_at
             FROM workflow_events WHERE run_id = ?1 AND sequence > ?2
             ORDER BY sequence LIMIT ?3",
        )?;
        let events = statement
            .query_map(params![run_id, after, limit + 1], read_event)?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = events.len() > limit;
        let events = events.into_iter().take(limit).collect::<Vec<_>>();
        let next_after = has_more
            .then(|| events.last().map(|event| event.sequence))
            .flatten();
        Ok(WorkflowEventPage { events, next_after })
    }

    pub fn attach_workflow_workspace(
        &self,
        run_id: &str,
        base_head: &str,
        branch: &str,
        worktree: &str,
    ) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE workflow_runs SET base_head = ?2, integration_branch = ?3,
                 integration_worktree = ?4, updated_at = ?5
             WHERE id = ?1 AND status = 'running'
               AND (integration_worktree IS NULL OR integration_worktree = ?4)",
            params![run_id, base_head, branch, worktree, Utc::now().to_rfc3339()],
        )?;
        if changed != 1 {
            return Err(AppError::conflict(
                "WorkflowRun 已绑定其他 worktree 或状态不可执行",
            ));
        }
        append_event_tx(
            &tx,
            run_id,
            "run",
            run_id,
            "run.workspace_attached",
            &json!({"base_head": base_head, "branch": branch}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn ensure_workflow_publication(
        &self,
        publication: &WorkflowPublication,
    ) -> Result<WorkflowPublication, AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO workflow_publications (
                run_id, mode, provider, phase, origin, target_branch, source_branch,
                review_url, head_commit, merge_commit, local_sync_status,
                local_sync_message, cleanup_status, remote_ci_fix_used, last_error, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                publication.run_id,
                to_json_string(&publication.mode)?,
                to_json_string(&publication.provider)?,
                to_json_string(&publication.phase)?,
                publication.origin,
                publication.target_branch,
                publication.source_branch,
                publication.review_url,
                publication.head_commit,
                publication.merge_commit,
                to_json_string(&publication.local_sync_status)?,
                publication.local_sync_message,
                to_json_string(&publication.cleanup_status)?,
                publication.remote_ci_fix_used,
                publication.last_error,
                publication.updated_at.to_rfc3339(),
            ],
        )?;
        let stored = load_publication(&tx, &publication.run_id)?
            .ok_or_else(|| AppError::internal("发布配置冻结失败"))?;
        if inserted == 1 {
            append_event_tx(
                &tx,
                &publication.run_id,
                "publication",
                &publication.run_id,
                "publication.prepared",
                &json!({
                    "mode": publication.mode,
                    "provider": publication.provider,
                    "target_branch": publication.target_branch,
                    "source_branch": publication.source_branch,
                }),
            )?;
        }
        tx.commit()?;
        Ok(stored)
    }

    pub fn save_workflow_publication(
        &self,
        publication: &WorkflowPublication,
        event_type: &str,
        event_payload: &Value,
    ) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE workflow_publications SET phase = ?2, review_url = ?3,
                 head_commit = ?4, merge_commit = ?5, local_sync_status = ?6,
                 local_sync_message = ?7, cleanup_status = ?8,
                 remote_ci_fix_used = ?9, last_error = ?10, updated_at = ?11
             WHERE run_id = ?1",
            params![
                publication.run_id,
                to_json_string(&publication.phase)?,
                publication.review_url,
                publication.head_commit,
                publication.merge_commit,
                to_json_string(&publication.local_sync_status)?,
                publication.local_sync_message,
                to_json_string(&publication.cleanup_status)?,
                publication.remote_ci_fix_used,
                publication.last_error,
                publication.updated_at.to_rfc3339(),
            ],
        )?;
        if changed != 1 {
            return Err(AppError::not_found("WorkflowRun 发布记录不存在"));
        }
        append_event_tx(
            &tx,
            &publication.run_id,
            "publication",
            &publication.run_id,
            event_type,
            event_payload,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn upsert_workflow_item_workspace(
        &self,
        workspace: &WorkflowItemWorkspace,
        event_type: &str,
    ) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO workflow_item_workspaces (
                work_item_id, run_id, branch, worktree_path, base_commit,
                result_commit, status, fallback_serial, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(work_item_id) DO UPDATE SET
                branch = excluded.branch, worktree_path = excluded.worktree_path,
                base_commit = excluded.base_commit, result_commit = excluded.result_commit,
                status = excluded.status, fallback_serial = excluded.fallback_serial,
                updated_at = excluded.updated_at",
            params![
                workspace.work_item_id,
                workspace.run_id,
                workspace.branch,
                workspace.worktree_path,
                workspace.base_commit,
                workspace.result_commit,
                to_json_string(&workspace.status)?,
                workspace.fallback_serial,
                workspace.updated_at.to_rfc3339(),
            ],
        )?;
        append_event_tx(
            &tx,
            &workspace.run_id,
            "item_workspace",
            &workspace.work_item_id,
            event_type,
            &json!({
                "branch": workspace.branch,
                "base_commit": workspace.base_commit,
                "result_commit": workspace.result_commit,
                "status": workspace.status,
                "fallback_serial": workspace.fallback_serial,
            }),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn runnable_work_items(
        &self,
        run_id: &str,
        limit: usize,
    ) -> Result<Vec<WorkItem>, AppError> {
        let conn = self.lock_connection();
        let ids = {
            let mut statement = conn.prepare(
                "SELECT wi.id, COALESCE(ws.fallback_serial, 0) FROM workflow_work_items wi
                 JOIN workflow_runs wr ON wr.id = wi.run_id
                 LEFT JOIN workflow_item_workspaces ws ON ws.work_item_id = wi.id
                 WHERE wi.run_id = ?1 AND wi.status = 'pending'
                   AND wr.status IN ('running','fixing')
                   AND NOT EXISTS (
                     SELECT 1 FROM workflow_dependencies d
                     JOIN workflow_work_items dependency ON dependency.id = d.depends_on_id
                     WHERE d.work_item_id = wi.id AND dependency.status != 'accepted'
                   )
                 ORDER BY wi.position LIMIT ?2",
            )?;
            let candidates = statement
                .query_map(params![run_id, limit.max(1)], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            if let Some((id, _)) = candidates.iter().find(|(_, fallback)| *fallback) {
                vec![id.clone()]
            } else {
                candidates.into_iter().map(|(id, _)| id).collect()
            }
        };
        let items = ids
            .iter()
            .map(|id| load_work_item(&conn, id))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    }

    pub fn start_workflow_attempt(
        &self,
        run_id: &str,
        work_item_id: Option<&str>,
        kind: WorkflowAttemptKind,
        model_tier: &str,
    ) -> Result<WorkflowAttempt, AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        if let Some(item_id) = work_item_id {
            let changed = tx.execute(
                "UPDATE workflow_work_items SET status = 'running', attempt_count = attempt_count + 1,
                     updated_at = ?2 WHERE id = ?1 AND status = 'pending'",
                params![item_id, Utc::now().to_rfc3339()],
            )?;
            if changed != 1 {
                return Err(AppError::conflict("工作项不再处于可执行状态"));
            }
        }
        let ordinal = tx.query_row(
            "SELECT COUNT(*) + 1 FROM workflow_attempts
             WHERE run_id = ?1 AND ((work_item_id = ?2) OR (work_item_id IS NULL AND ?2 IS NULL))",
            params![run_id, work_item_id],
            |row| row.get::<_, u32>(0),
        )?;
        let attempt = WorkflowAttempt {
            id: new_workflow_id("attempt"),
            run_id: run_id.to_owned(),
            work_item_id: work_item_id.map(ToOwned::to_owned),
            kind,
            ordinal,
            status: WorkflowAttemptStatus::Running,
            model_tier: model_tier.to_owned(),
            pi_session_file: None,
            worktree_fingerprint: None,
            result_summary: None,
            failure_class: None,
            failure_message: None,
            usage: None,
            started_at: Utc::now(),
            completed_at: None,
        };
        insert_attempt(&tx, &attempt)?;
        append_event_tx(
            &tx,
            run_id,
            "attempt",
            &attempt.id,
            "attempt.started",
            &json!({"kind": kind, "work_item_id": work_item_id, "ordinal": ordinal}),
        )?;
        tx.commit()?;
        Ok(attempt)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finish_workflow_attempt(
        &self,
        attempt_id: &str,
        succeeded: bool,
        session_file: Option<&str>,
        worktree_fingerprint: Option<&str>,
        result_summary: Option<&str>,
        failure_class: Option<FailureClass>,
        failure_message: Option<&str>,
        usage: Option<&Value>,
    ) -> Result<(), AppError> {
        let usage = usage.and_then(OperationMetrics::from_trace);
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let (run_id, work_item_id, kind) = tx.query_row(
            "SELECT run_id, work_item_id, kind FROM workflow_attempts WHERE id = ?1",
            [attempt_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    parse_json_column::<WorkflowAttemptKind>(row, 2)?,
                ))
            },
        )?;
        let changed = tx.execute(
            "UPDATE workflow_attempts SET status = ?2, pi_session_file = ?3,
                 worktree_fingerprint = ?4, result_summary = ?5, failure_class = ?6,
                 failure_message = ?7, usage = ?8, completed_at = ?9
             WHERE id = ?1 AND status = 'running'",
            params![
                attempt_id,
                if succeeded { "succeeded" } else { "failed" },
                session_file,
                worktree_fingerprint,
                result_summary,
                failure_class
                    .map(|value| to_json_string(&value))
                    .transpose()?,
                failure_message,
                usage.as_ref().map(serde_json::to_string).transpose()?,
                Utc::now().to_rfc3339(),
            ],
        )?;
        if changed != 1 {
            return Err(AppError::conflict("执行尝试已经结束或不存在"));
        }
        if let Some(item_id) = &work_item_id {
            let technical = !succeeded && failure_class.is_some_and(FailureClass::is_technical);
            tx.execute(
                "UPDATE workflow_work_items SET status = ?2,
                     attempt_count = CASE WHEN ?3 THEN MAX(attempt_count - 1, 0) ELSE attempt_count END,
                     accepted_attempt_id = CASE WHEN ?4 THEN ?5 ELSE accepted_attempt_id END,
                     updated_at = ?6
                 WHERE id = ?1 AND status = 'running'",
                params![
                    item_id,
                    if succeeded {
                        "accepted"
                    } else if technical {
                        "pending"
                    } else {
                        "blocked"
                    },
                    technical,
                    succeeded,
                    attempt_id,
                    Utc::now().to_rfc3339(),
                ],
            )?;
        } else if kind == WorkflowAttemptKind::Rescue
            && !succeeded
            && failure_class.is_some_and(FailureClass::is_technical)
        {
            let completed_rescue_turns = tx.query_row(
                "SELECT COUNT(*) FROM workflow_attempts
                 WHERE run_id = ?1 AND kind = 'rescue' AND status = 'succeeded'",
                [&run_id],
                |row| row.get::<_, u32>(0),
            )?;
            if completed_rescue_turns == 0 {
                tx.execute(
                    "UPDATE workflow_runs SET rescue_used = 0, rescue_attempt_id = NULL,
                         updated_at = ?2
                     WHERE id = ?1 AND status = 'rescuing'",
                    params![run_id, Utc::now().to_rfc3339()],
                )?;
            }
        } else if kind == WorkflowAttemptKind::Rescue
            && !succeeded
            && failure_class.is_some_and(|class| !class.is_technical())
        {
            tx.execute(
                "UPDATE workflow_runs SET status = 'blocked', blocked_reason = ?2,
                     updated_at = ?3, completed_at = ?3
                 WHERE id = ?1 AND status = 'rescuing'",
                params![run_id, failure_message, Utc::now().to_rfc3339()],
            )?;
        }
        append_event_tx(
            &tx,
            &run_id,
            "attempt",
            attempt_id,
            if succeeded {
                "attempt.succeeded"
            } else {
                "attempt.failed"
            },
            &json!({"failure_class": failure_class, "failure_message": failure_message}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn observe_workflow_attempt(
        &self,
        attempt_id: &str,
        session_file: Option<&str>,
        worktree_fingerprint: Option<&str>,
        result_summary: Option<&str>,
        usage: Option<&Value>,
    ) -> Result<(), AppError> {
        let usage = usage.and_then(OperationMetrics::from_trace);
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let run_id = tx
            .query_row(
                "SELECT run_id FROM workflow_attempts WHERE id = ?1 AND status = 'running'",
                [attempt_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::conflict("执行尝试已经结束或不存在"))?;
        tx.execute(
            "UPDATE workflow_attempts SET pi_session_file = COALESCE(?2, pi_session_file),
                 worktree_fingerprint = COALESCE(?3, worktree_fingerprint),
                 result_summary = COALESCE(?4, result_summary),
                 usage = COALESCE(?5, usage) WHERE id = ?1 AND status = 'running'",
            params![
                attempt_id,
                session_file,
                worktree_fingerprint,
                result_summary,
                usage.as_ref().map(serde_json::to_string).transpose()?,
            ],
        )?;
        append_event_tx(
            &tx,
            &run_id,
            "attempt",
            attempt_id,
            "attempt.usage_persisted",
            &json!({"usage_known": usage.is_some()}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn supersede_workflow_attempt(
        &self,
        attempt_id: &str,
        reason: &str,
        session_file: Option<&str>,
        worktree_fingerprint: Option<&str>,
        result_summary: Option<&str>,
        usage: Option<&Value>,
    ) -> Result<(), AppError> {
        let usage = usage.and_then(OperationMetrics::from_trace);
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let (run_id, work_item_id) = tx.query_row(
            "SELECT run_id, work_item_id FROM workflow_attempts WHERE id = ?1",
            [attempt_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )?;
        let work_item_id = work_item_id
            .ok_or_else(|| AppError::bad_request("run 级 attempt 不能标记为 superseded"))?;
        let now = Utc::now().to_rfc3339();
        let changed = tx.execute(
            "UPDATE workflow_attempts SET status = 'superseded', failure_class = 'git_conflict',
                 failure_message = ?2, pi_session_file = ?3, worktree_fingerprint = ?4,
                 result_summary = ?5, usage = ?6, completed_at = ?7
             WHERE id = ?1 AND status = 'running'",
            params![
                attempt_id,
                reason,
                session_file,
                worktree_fingerprint,
                result_summary,
                usage.as_ref().map(serde_json::to_string).transpose()?,
                now
            ],
        )?;
        if changed != 1 {
            return Err(AppError::conflict("执行尝试已经结束或不存在"));
        }
        tx.execute(
            "UPDATE workflow_work_items SET status = 'pending',
                 attempt_count = MAX(attempt_count - 1, 0), accepted_attempt_id = NULL,
                 updated_at = ?2 WHERE id = ?1",
            params![work_item_id, now],
        )?;
        tx.execute(
            "UPDATE workflow_item_workspaces SET status = 'superseded', fallback_serial = 1,
                 updated_at = ?2 WHERE work_item_id = ?1",
            params![work_item_id, now],
        )?;
        append_event_tx(
            &tx,
            &run_id,
            "attempt",
            attempt_id,
            "attempt.superseded",
            &json!({
                "work_item_id": work_item_id,
                "reason": reason,
                "usage_known": usage.is_some()
            }),
        )?;
        append_event_tx(
            &tx,
            &run_id,
            "run",
            &run_id,
            "parallel_batch.serial_fallback",
            &json!({"work_item_id": work_item_id, "reason": reason}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn prepare_work_item_fix(&self, work_item_id: &str) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let run_id = tx.query_row(
            "SELECT run_id FROM workflow_work_items WHERE id = ?1",
            [work_item_id],
            |row| row.get::<_, String>(0),
        )?;
        let changed = tx.execute(
            "UPDATE workflow_work_items SET status = 'pending', accepted_attempt_id = NULL,
                 updated_at = ?2 WHERE id = ?1 AND status IN ('blocked','accepted')",
            params![work_item_id, Utc::now().to_rfc3339()],
        )?;
        if changed != 1 {
            return Err(AppError::conflict("工作项当前不能进入 Fix 阶段"));
        }
        tx.execute(
            "UPDATE workflow_runs SET status = 'fixing', updated_at = ?2
             WHERE id = ?1 AND status NOT IN ('completed','blocked','cancelled')",
            params![run_id, Utc::now().to_rfc3339()],
        )?;
        append_event_tx(
            &tx,
            &run_id,
            "work_item",
            work_item_id,
            "work_item.fix_requested",
            &json!({}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn record_workflow_validation(
        &self,
        validation: &WorkflowValidation,
    ) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO workflow_validations (
                id, run_id, attempt_id, checkpoint_id, command, source, gating,
                baseline_status, final_status, baseline_exit_code, final_exit_code,
                output_summary, worktree_fingerprint, created_at, completed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET
                attempt_id = excluded.attempt_id,
                checkpoint_id = excluded.checkpoint_id,
                source = excluded.source,
                gating = excluded.gating,
                baseline_status = excluded.baseline_status,
                final_status = excluded.final_status,
                baseline_exit_code = excluded.baseline_exit_code,
                final_exit_code = excluded.final_exit_code,
                output_summary = excluded.output_summary,
                worktree_fingerprint = excluded.worktree_fingerprint,
                completed_at = excluded.completed_at",
            params![
                validation.id,
                validation.run_id,
                validation.attempt_id,
                validation.checkpoint_id,
                validation.command,
                to_json_string(&validation.source)?,
                validation.gating,
                to_json_string(&validation.baseline_status)?,
                to_json_string(&validation.final_status)?,
                validation.baseline_exit_code,
                validation.final_exit_code,
                validation.output_summary,
                validation.worktree_fingerprint,
                validation.created_at.to_rfc3339(),
                validation.completed_at.map(|value| value.to_rfc3339()),
            ],
        )?;
        append_event_tx(
            &tx,
            &validation.run_id,
            "validation",
            &validation.id,
            "validation.completed",
            &json!({
                "command": validation.command,
                "source": validation.source,
                "gating": validation.gating,
                "baseline_status": validation.baseline_status,
                "final_status": validation.final_status,
                "fingerprint": validation.worktree_fingerprint,
            }),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn create_checkpoint(
        &self,
        run_id: &str,
        kind: CheckpointKind,
        snapshot_sha: &str,
        required_angles: &[ReviewAngle],
    ) -> Result<WorkflowCheckpoint, AppError> {
        if required_angles.is_empty() {
            return Err(AppError::bad_request("审核必须至少执行一个角度"));
        }
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let revision = tx.query_row(
            "SELECT COUNT(*) + 1 FROM workflow_checkpoints WHERE run_id = ?1 AND kind = ?2",
            params![run_id, to_json_string(&kind)?],
            |row| row.get::<_, u32>(0),
        )?;
        let now = Utc::now();
        let checkpoint = WorkflowCheckpoint {
            id: new_workflow_id("checkpoint"),
            run_id: run_id.to_owned(),
            kind,
            revision,
            status: CheckpointStatus::Reviewing,
            snapshot_sha: snapshot_sha.to_owned(),
            required_angles: required_angles.to_vec(),
            summary: None,
            review_details: None,
            usage: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        };
        insert_checkpoint(&tx, &checkpoint)?;
        tx.execute(
            "UPDATE workflow_runs SET status = 'reviewing', updated_at = ?2
             WHERE id = ?1 AND status NOT IN ('completed','blocked','cancelled')",
            params![run_id, now.to_rfc3339()],
        )?;
        append_event_tx(
            &tx,
            run_id,
            "checkpoint",
            &checkpoint.id,
            "checkpoint.started",
            &json!({"kind": kind, "required_angles": required_angles}),
        )?;
        tx.commit()?;
        Ok(checkpoint)
    }

    pub fn store_review_findings(
        &self,
        checkpoint_id: &str,
        findings: &[WorkflowReviewFinding],
        reviewed_angles: &[ReviewAngle],
    ) -> Result<Vec<WorkflowReviewFinding>, AppError> {
        let mut deduped = HashMap::new();
        for finding in findings {
            if finding.checkpoint_id != checkpoint_id {
                return Err(AppError::bad_request("审核 finding 不属于当前 checkpoint"));
            }
            let key = (
                finding.angle,
                finding.category.trim().to_owned(),
                finding.path.clone().unwrap_or_default(),
                finding.location.clone().unwrap_or_default(),
            );
            deduped
                .entry(key)
                .and_modify(|current: &mut WorkflowReviewFinding| {
                    if finding.priority < current.priority {
                        *current = finding.clone();
                    }
                })
                .or_insert_with(|| finding.clone());
        }
        let mut findings = deduped.into_values().collect::<Vec<_>>();
        findings.sort_by_key(|finding| finding.priority);

        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let run_id = tx.query_row(
            "SELECT run_id FROM workflow_checkpoints WHERE id = ?1",
            [checkpoint_id],
            |row| row.get::<_, String>(0),
        )?;
        if reviewed_angles.is_empty() {
            return Err(AppError::bad_request(
                "保存审核 finding 时至少需要一个已完成角度",
            ));
        }
        let current_keys = findings
            .iter()
            .map(|finding| {
                (
                    finding.angle,
                    finding.category.trim().to_owned(),
                    finding.path.clone().unwrap_or_default(),
                    finding.location.clone().unwrap_or_default(),
                )
            })
            .collect::<HashSet<_>>();
        let previous_open = {
            let mut statement = tx.prepare(
                "SELECT id, checkpoint_id, angle, priority, status, category, path, location,
                        summary, evidence, reproduction, remediation, scenario_ref, created_at, updated_at
                 FROM workflow_review_findings
                 WHERE checkpoint_id != ?1 AND status = 'open'
                   AND checkpoint_id IN (SELECT id FROM workflow_checkpoints WHERE run_id = ?2)",
            )?;
            statement
                .query_map(params![checkpoint_id, run_id], read_finding)?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut resolved = 0usize;
        for previous in previous_open {
            let key = (
                previous.angle,
                previous.category.trim().to_owned(),
                previous.path.clone().unwrap_or_default(),
                previous.location.clone().unwrap_or_default(),
            );
            if reviewed_angles.contains(&previous.angle) {
                let changed = tx.execute(
                    "UPDATE workflow_review_findings SET status = ?2, updated_at = ?3
                     WHERE id = ?1 AND status = 'open'",
                    params![
                        previous.id,
                        to_json_string(&FindingStatus::Resolved)?,
                        Utc::now().to_rfc3339()
                    ],
                )?;
                if !current_keys.contains(&key) {
                    resolved += changed;
                }
            }
        }
        tx.execute(
            "DELETE FROM workflow_review_findings WHERE checkpoint_id = ?1",
            [checkpoint_id],
        )?;
        for finding in &findings {
            tx.execute(
                "INSERT INTO workflow_review_findings (
                    id, checkpoint_id, angle, priority, status, category, path, location,
                    summary, evidence, reproduction, remediation, scenario_ref, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    finding.id,
                    finding.checkpoint_id,
                    to_json_string(&finding.angle)?,
                    to_json_string(&finding.priority)?,
                    to_json_string(&finding.status)?,
                    finding.category,
                    finding.path.clone().unwrap_or_default(),
                    finding.location.clone().unwrap_or_default(),
                    finding.summary,
                    finding.evidence,
                    finding.reproduction,
                    finding.remediation,
                    finding.scenario_ref,
                    finding.created_at.to_rfc3339(),
                    finding.updated_at.to_rfc3339(),
                ],
            )?;
        }
        append_event_tx(
            &tx,
            &run_id,
            "checkpoint",
            checkpoint_id,
            "checkpoint.findings_recorded",
            &json!({
                "blocking": findings.iter().filter(|finding| finding.priority.is_blocking()).count(),
                "advisory": findings.iter().filter(|finding| !finding.priority.is_blocking()).count(),
                "resolved": resolved,
            }),
        )?;
        tx.commit()?;
        Ok(findings)
    }

    pub fn record_checkpoint_review_observation(
        &self,
        checkpoint_id: &str,
        details: Option<&ReviewReport>,
        usage: Option<&Value>,
    ) -> Result<(), AppError> {
        let usage = usage.and_then(OperationMetrics::from_trace);
        let transport_status = if details
            .map(|details| &details.reviews)
            .is_some_and(|reviews| {
                !reviews.is_empty()
                    && reviews
                        .iter()
                        .all(|review| review.transport_status == ReviewTransportStatus::Completed)
            }) {
            "completed"
        } else {
            "failed"
        };
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let run_id = tx.query_row(
            "SELECT run_id FROM workflow_checkpoints WHERE id = ?1",
            [checkpoint_id],
            |row| row.get::<_, String>(0),
        )?;
        tx.execute(
            "UPDATE workflow_checkpoints SET review_details = ?2, usage = ?3, updated_at = ?4 WHERE id = ?1",
            params![
                checkpoint_id,
                details.map(serde_json::to_string).transpose()?,
                usage.as_ref().map(serde_json::to_string).transpose()?,
                Utc::now().to_rfc3339(),
            ],
        )?;
        append_event_tx(
            &tx,
            &run_id,
            "checkpoint",
            checkpoint_id,
            "checkpoint.review_observed",
            &json!({"transport_status": transport_status, "usage_known": usage.is_some()}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn finish_checkpoint(
        &self,
        checkpoint_id: &str,
        status: CheckpointStatus,
        summary: &str,
    ) -> Result<(), AppError> {
        if !matches!(
            status,
            CheckpointStatus::Approved
                | CheckpointStatus::Rejected
                | CheckpointStatus::TechnicalFailure
                | CheckpointStatus::Cancelled
        ) {
            return Err(AppError::bad_request("checkpoint 结束状态无效"));
        }
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let run_id = tx.query_row(
            "SELECT run_id FROM workflow_checkpoints WHERE id = ?1",
            [checkpoint_id],
            |row| row.get::<_, String>(0),
        )?;
        let now = Utc::now().to_rfc3339();
        let changed = tx.execute(
            "UPDATE workflow_checkpoints SET status = ?2, summary = ?3,
                 updated_at = ?4, completed_at = ?4 WHERE id = ?1 AND status = 'reviewing'",
            params![checkpoint_id, to_json_string(&status)?, summary, now],
        )?;
        if changed != 1 {
            return Err(AppError::conflict("checkpoint 已结束或不存在"));
        }
        append_event_tx(
            &tx,
            &run_id,
            "checkpoint",
            checkpoint_id,
            match status {
                CheckpointStatus::Approved => "checkpoint.approved",
                CheckpointStatus::Rejected => "checkpoint.rejected",
                CheckpointStatus::TechnicalFailure => "checkpoint.technical_failure",
                CheckpointStatus::Cancelled => "checkpoint.cancelled",
                _ => unreachable!(),
            },
            &json!({"summary": summary}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn complete_after_integration(
        &self,
        checkpoint_id: &str,
        final_commit: &str,
        summary: &str,
        accept_all_work_items: bool,
    ) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let run_id = tx.query_row(
            "SELECT run_id FROM workflow_checkpoints WHERE id = ?1",
            [checkpoint_id],
            |row| row.get::<_, String>(0),
        )?;
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE workflow_checkpoints SET status = 'approved', summary = ?2,
                 updated_at = ?3, completed_at = ?3 WHERE id = ?1",
            params![checkpoint_id, summary, now],
        )?;
        if accept_all_work_items {
            tx.execute(
                "UPDATE workflow_work_items SET status = 'accepted', updated_at = ?2
                 WHERE run_id = ?1 AND status != 'cancelled'",
                params![run_id, now],
            )?;
        }
        let remaining = tx.query_row(
            "SELECT COUNT(*) FROM workflow_work_items WHERE run_id = ?1 AND status != 'accepted'",
            [&run_id],
            |row| row.get::<_, u32>(0),
        )?;
        if remaining != 0 {
            return Err(AppError::conflict(
                "仍有未接收的工作项，不能完成 WorkflowRun",
            ));
        }
        tx.execute(
            "UPDATE workflow_runs SET status = 'completed', final_commit = ?2,
                 blocked_reason = NULL, paused_operation = NULL,
                 updated_at = ?3, completed_at = ?3 WHERE id = ?1",
            params![run_id, final_commit, now],
        )?;
        append_event_tx(
            &tx,
            &run_id,
            "run",
            &run_id,
            "run.completed",
            &json!({"final_commit": final_commit}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn begin_workflow_publication(
        &self,
        checkpoint_id: &str,
        integration_commit: &str,
        summary: &str,
    ) -> Result<String, AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let run_id = tx.query_row(
            "SELECT run_id FROM workflow_checkpoints WHERE id = ?1",
            [checkpoint_id],
            |row| row.get::<_, String>(0),
        )?;
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE workflow_checkpoints SET status = 'approved', summary = ?2,
                 updated_at = ?3, completed_at = ?3 WHERE id = ?1",
            params![checkpoint_id, summary, now],
        )?;
        tx.execute(
            "UPDATE workflow_runs SET status = 'publishing', final_commit = NULL,
                 blocked_reason = NULL, paused_operation = NULL, updated_at = ?2
             WHERE id = ?1 AND status NOT IN ('completed','blocked','cancelled')",
            params![run_id, now],
        )?;
        append_event_tx(
            &tx,
            &run_id,
            "run",
            &run_id,
            "run.publishing",
            &json!({"integration_commit": integration_commit}),
        )?;
        tx.commit()?;
        Ok(run_id)
    }

    pub fn begin_run_rescue(
        &self,
        run_id: &str,
        trigger: &str,
    ) -> Result<WorkflowAttempt, AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE workflow_runs SET status = 'rescuing', rescue_used = 1,
                 blocked_reason = NULL, paused_operation = NULL,
                 updated_at = ?2 WHERE id = ?1 AND rescue_used = 0
                 AND status NOT IN ('completed','cancelled','paused_technical')",
            params![run_id, Utc::now().to_rfc3339()],
        )?;
        if changed != 1 {
            return Err(AppError::conflict("该 WorkflowRun 不能使用 Rescue"));
        }
        let ordinal = tx.query_row(
            "SELECT COUNT(*) + 1 FROM workflow_attempts WHERE run_id = ?1 AND work_item_id IS NULL",
            [run_id],
            |row| row.get::<_, u32>(0),
        )?;
        let attempt = WorkflowAttempt {
            id: new_workflow_id("rescue"),
            run_id: run_id.to_owned(),
            work_item_id: None,
            kind: WorkflowAttemptKind::Rescue,
            ordinal,
            status: WorkflowAttemptStatus::Running,
            model_tier: "high".to_owned(),
            pi_session_file: None,
            worktree_fingerprint: None,
            result_summary: None,
            failure_class: None,
            failure_message: None,
            usage: None,
            started_at: Utc::now(),
            completed_at: None,
        };
        insert_attempt(&tx, &attempt)?;
        tx.execute(
            "UPDATE workflow_runs SET rescue_attempt_id = ?2 WHERE id = ?1",
            params![run_id, attempt.id],
        )?;
        append_event_tx(
            &tx,
            run_id,
            "run",
            run_id,
            "run.rescue_started",
            &json!({"attempt_id": attempt.id, "trigger": trigger}),
        )?;
        tx.commit()?;
        Ok(attempt)
    }

    pub fn pause_workflow_run(
        &self,
        run_id: &str,
        operation: &str,
        reason: &str,
    ) -> Result<(), AppError> {
        let operation = operation
            .parse::<PausedOperation>()
            .map_err(|()| AppError::bad_request(format!("未知的可恢复 operation：{operation}")))?;
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE workflow_work_items
             SET attempt_count = MAX(attempt_count - 1, 0), updated_at = ?2
             WHERE run_id = ?1 AND id IN (
                SELECT work_item_id FROM workflow_attempts
                WHERE run_id = ?1 AND status = 'running' AND work_item_id IS NOT NULL
             )",
            params![run_id, now],
        )?;
        tx.execute(
            "UPDATE workflow_attempts
             SET status = 'failed', failure_class = 'infrastructure', failure_message = ?2,
                 completed_at = ?3 WHERE run_id = ?1 AND status = 'running'",
            params![run_id, reason, now],
        )?;
        tx.execute(
            "UPDATE workflow_checkpoints
             SET status = 'technical_failure', summary = ?2, updated_at = ?3, completed_at = ?3
             WHERE run_id = ?1 AND status = 'reviewing'",
            params![run_id, reason, now],
        )?;
        tx.execute(
            "UPDATE workflow_work_items
             SET status = CASE WHEN status = 'running' THEN 'pending' ELSE status END,
                 updated_at = ?2 WHERE run_id = ?1",
            params![run_id, now],
        )?;
        tx.execute(
            "UPDATE workflow_runs SET rescue_used = 0, rescue_attempt_id = NULL
             WHERE id = ?1 AND rescue_used = 1 AND NOT EXISTS (
                SELECT 1 FROM workflow_attempts
                WHERE run_id = ?1 AND kind = 'rescue' AND status = 'succeeded'
             )",
            [run_id],
        )?;
        let changed = tx.execute(
            "UPDATE workflow_runs SET status = 'paused_technical', paused_operation = ?2,
                 blocked_reason = ?3, updated_at = ?4
             WHERE id = ?1 AND status NOT IN ('completed','blocked','cancelled')",
            params![run_id, operation.as_str(), reason, now],
        )?;
        if changed != 1 {
            return Err(AppError::conflict("WorkflowRun 已结束或不存在"));
        }
        append_event_tx(
            &tx,
            run_id,
            "run",
            run_id,
            "run.paused_technical",
            &json!({"operation": operation, "reason": reason}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn resume_workflow_run(&self, run_id: &str) -> Result<PausedOperation, AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let operation = tx
            .query_row(
                "SELECT paused_operation FROM workflow_runs WHERE id = ?1 AND status = 'paused_technical'",
                [run_id],
                |row| parse_optional_json_column::<PausedOperation>(row, 0),
            )
            .optional()?
            .flatten()
            .ok_or_else(|| AppError::conflict("只有 paused_technical WorkflowRun 可以恢复"))?;
        let requires_clean_restart = operation == PausedOperation::WorkspaceViolation
            || tx.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM workflow_attempts
                    WHERE run_id = ?1 AND failure_class = 'workspace_violation'
                 ) OR (
                    SELECT COUNT(*) FROM workflow_attempts
                    WHERE run_id = ?1 AND status = 'superseded'
                      AND failure_class = 'git_conflict'
                 ) >= 2",
                [run_id],
                |row| row.get::<_, bool>(0),
            )?;
        if requires_clean_restart {
            return Err(AppError::conflict(
                "该 WorkflowRun 存在工作区越界或重复 Git 冲突，请从干净工作区重新执行",
            ));
        }
        tx.execute(
            "UPDATE workflow_runs SET status = 'running',
                 blocked_reason = NULL, updated_at = ?2 WHERE id = ?1",
            params![run_id, Utc::now().to_rfc3339()],
        )?;
        append_event_tx(
            &tx,
            run_id,
            "run",
            run_id,
            "run.resumed",
            &json!({"operation": operation}),
        )?;
        tx.commit()?;
        Ok(operation)
    }

    pub fn transition_workflow_run(
        &self,
        run_id: &str,
        status: WorkflowRunStatus,
        reason: Option<&str>,
    ) -> Result<(), AppError> {
        let mut conn = self.lock_connection();
        let tx = conn.transaction()?;
        let now = Utc::now().to_rfc3339();
        let changed = tx.execute(
            "UPDATE workflow_runs SET status = ?2, blocked_reason = ?3,
                 paused_operation = CASE WHEN ?2 = 'paused_technical' THEN paused_operation ELSE NULL END,
                 updated_at = ?4,
                 completed_at = CASE WHEN ?5 THEN ?4 ELSE NULL END
             WHERE id = ?1 AND status NOT IN ('completed','cancelled')",
            params![run_id, to_json_string(&status)?, reason, now, status.is_terminal()],
        )?;
        if changed != 1 {
            return Err(AppError::conflict("WorkflowRun 已结束或不存在"));
        }
        append_event_tx(
            &tx,
            run_id,
            "run",
            run_id,
            &format!("run.{}", to_json_string(&status)?),
            &json!({"reason": reason}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn block_workflow_run(&self, run_id: &str, reason: &str) -> Result<(), AppError> {
        self.transition_workflow_run(run_id, WorkflowRunStatus::Blocked, Some(reason))
    }
}

fn insert_run(tx: &rusqlite::Transaction<'_>, run: &WorkflowRun) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO workflow_runs (
            id, requirement_id, status, change_spec, design_notes, plan_summary,
            source_revision, base_head, integration_branch, integration_worktree, final_commit,
            rescue_used, rescue_attempt_id, blocked_reason, paused_operation, replaces_run_id,
            created_at, updated_at, completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            run.id,
            run.requirement_id,
            to_json_string(&run.status)?,
            serde_json::to_string(&run.change_spec)?,
            serde_json::to_string(&run.design_notes)?,
            run.plan_summary,
            run.source_revision,
            run.base_head,
            run.integration_branch,
            run.integration_worktree,
            run.final_commit,
            run.rescue_used,
            run.rescue_attempt_id,
            run.blocked_reason,
            run.paused_operation.map(|value| to_json_string(&value)).transpose()?,
            run.replaces_run_id,
            run.created_at.to_rfc3339(),
            run.updated_at.to_rfc3339(),
            run.completed_at.map(|value| value.to_rfc3339()),
        ],
    )?;
    Ok(())
}

fn insert_work_item(tx: &rusqlite::Transaction<'_>, item: &WorkItem) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO workflow_work_items (
            id, run_id, position, objective, scenario_refs, group_name, scope_hints,
            verification_goals, status, attempt_count, accepted_attempt_id, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            item.id,
            item.run_id,
            item.position,
            item.objective,
            serde_json::to_string(&item.scenario_refs)?,
            item.group,
            serde_json::to_string(&item.scope_hints)?,
            serde_json::to_string(&item.verification_goals)?,
            to_json_string(&item.status)?,
            item.attempt_count,
            item.accepted_attempt_id,
            item.created_at.to_rfc3339(),
            item.updated_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn insert_attempt(
    tx: &rusqlite::Transaction<'_>,
    attempt: &WorkflowAttempt,
) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO workflow_attempts (
            id, run_id, work_item_id, kind, ordinal, status, model_tier, pi_session_file,
            worktree_fingerprint, result_summary, failure_class, failure_message, usage,
            started_at, completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            attempt.id,
            attempt.run_id,
            attempt.work_item_id,
            to_json_string(&attempt.kind)?,
            attempt.ordinal,
            to_json_string(&attempt.status)?,
            attempt.model_tier,
            attempt.pi_session_file,
            attempt.worktree_fingerprint,
            attempt.result_summary,
            attempt
                .failure_class
                .map(|value| to_json_string(&value))
                .transpose()?,
            attempt.failure_message,
            attempt
                .usage
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            attempt.started_at.to_rfc3339(),
            attempt.completed_at.map(|value| value.to_rfc3339()),
        ],
    )?;
    Ok(())
}

fn insert_checkpoint(
    tx: &rusqlite::Transaction<'_>,
    checkpoint: &WorkflowCheckpoint,
) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO workflow_checkpoints (
            id, run_id, kind, revision, status, snapshot_sha, required_angles,
            summary, review_details, usage, created_at, updated_at, completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            checkpoint.id,
            checkpoint.run_id,
            to_json_string(&checkpoint.kind)?,
            checkpoint.revision,
            to_json_string(&checkpoint.status)?,
            checkpoint.snapshot_sha,
            serde_json::to_string(&checkpoint.required_angles)?,
            checkpoint.summary,
            checkpoint
                .review_details
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            checkpoint
                .usage
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            checkpoint.created_at.to_rfc3339(),
            checkpoint.updated_at.to_rfc3339(),
            checkpoint.completed_at.map(|value| value.to_rfc3339()),
        ],
    )?;
    Ok(())
}

fn append_event_tx<T: Serialize>(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
    entity_type: &str,
    entity_id: &str,
    event_type: &str,
    payload: &T,
) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO workflow_events (
            run_id, entity_type, entity_id, event_type, payload, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            run_id,
            entity_type,
            entity_id,
            event_type,
            serde_json::to_string(payload)?,
            Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn load_snapshot(conn: &rusqlite::Connection, run_id: &str) -> Result<WorkflowSnapshot, AppError> {
    let run = conn
        .query_row(
            "SELECT id, requirement_id, status, change_spec, design_notes,
                    plan_summary, source_revision, base_head, integration_branch,
                    integration_worktree, final_commit, rescue_used, rescue_attempt_id,
                    blocked_reason, paused_operation, replaces_run_id, created_at,
                    updated_at, completed_at
             FROM workflow_runs WHERE id = ?1",
            [run_id],
            read_run,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("WorkflowRun 不存在"))?;
    let mut work_items = query_rows(
        conn,
        "SELECT id, run_id, position, objective, scenario_refs, group_name, scope_hints,
                verification_goals, status, attempt_count, accepted_attempt_id, created_at, updated_at
         FROM workflow_work_items WHERE run_id = ?1 ORDER BY position",
        run_id,
        read_work_item,
    )?;
    let dependencies = query_rows(
        conn,
        "SELECT work_item_id, depends_on_id FROM workflow_dependencies
         WHERE work_item_id IN (SELECT id FROM workflow_work_items WHERE run_id = ?1)",
        run_id,
        |row| {
            Ok(WorkItemDependency {
                work_item_id: row.get(0)?,
                depends_on_id: row.get(1)?,
            })
        },
    )?;
    let attempts = query_rows(
        conn,
        "SELECT id, run_id, work_item_id, kind, ordinal, status, model_tier, pi_session_file,
                worktree_fingerprint, result_summary, failure_class, failure_message, usage,
                started_at, completed_at
         FROM workflow_attempts WHERE run_id = ?1 ORDER BY started_at, id",
        run_id,
        read_attempt,
    )?;
    for item in &mut work_items {
        item.actual_attempt_count = attempts
            .iter()
            .filter(|attempt| attempt.work_item_id.as_deref() == Some(item.id.as_str()))
            .count() as u32;
    }
    let checkpoints = query_rows(
        conn,
        "SELECT id, run_id, kind, revision, status, snapshot_sha, required_angles,
                summary, review_details, usage, created_at, updated_at, completed_at
         FROM workflow_checkpoints WHERE run_id = ?1 ORDER BY created_at, id",
        run_id,
        read_checkpoint,
    )?;
    let validations = query_rows(
        conn,
        "SELECT id, run_id, attempt_id, checkpoint_id, command, source, gating,
                baseline_status, final_status, baseline_exit_code, final_exit_code,
                output_summary, worktree_fingerprint, created_at, completed_at
         FROM workflow_validations WHERE run_id = ?1 ORDER BY created_at, id",
        run_id,
        read_validation,
    )?;
    let findings = query_rows(
        conn,
        "SELECT id, checkpoint_id, angle, priority, status, category, path, location,
                summary, evidence, reproduction, remediation, scenario_ref, created_at, updated_at
         FROM workflow_review_findings
         WHERE checkpoint_id IN (SELECT id FROM workflow_checkpoints WHERE run_id = ?1)
         ORDER BY created_at, id",
        run_id,
        read_finding,
    )?;
    let publication = load_publication(conn, run_id)?;
    let item_workspaces = query_rows(
        conn,
        "SELECT work_item_id, run_id, branch, worktree_path, base_commit,
                result_commit, status, fallback_serial, updated_at
         FROM workflow_item_workspaces WHERE run_id = ?1 ORDER BY work_item_id",
        run_id,
        read_item_workspace,
    )?;
    let last_event_sequence = conn.query_row(
        "SELECT COALESCE(MAX(sequence), 0) FROM workflow_events WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    Ok(WorkflowSnapshot {
        run,
        work_items,
        dependencies,
        attempts,
        checkpoints,
        validations,
        findings,
        publication,
        item_workspaces,
        last_event_sequence,
    })
}

fn load_publication(
    conn: &rusqlite::Connection,
    run_id: &str,
) -> Result<Option<WorkflowPublication>, AppError> {
    Ok(conn
        .query_row(
            "SELECT run_id, mode, provider, phase, origin, target_branch, source_branch,
                    review_url, head_commit, merge_commit, local_sync_status,
                    local_sync_message, cleanup_status, remote_ci_fix_used, last_error, updated_at
             FROM workflow_publications WHERE run_id = ?1",
            [run_id],
            read_publication,
        )
        .optional()?)
}

fn query_rows<T>(
    conn: &rusqlite::Connection,
    sql: &str,
    run_id: &str,
    read: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, AppError> {
    let mut statement = conn.prepare(sql)?;
    Ok(statement
        .query_map([run_id], read)?
        .collect::<Result<Vec<_>, _>>()?)
}

fn load_work_item(conn: &rusqlite::Connection, id: &str) -> Result<WorkItem, AppError> {
    Ok(conn.query_row(
        "SELECT id, run_id, position, objective, scenario_refs, group_name, scope_hints,
                verification_goals, status, attempt_count, accepted_attempt_id, created_at, updated_at
         FROM workflow_work_items WHERE id = ?1",
        [id],
        read_work_item,
    )?)
}

fn read_run(row: &Row<'_>) -> rusqlite::Result<WorkflowRun> {
    Ok(WorkflowRun {
        id: row.get(0)?,
        requirement_id: row.get(1)?,
        status: parse_json_column(row, 2)?,
        change_spec: parse_json_column(row, 3)?,
        design_notes: parse_json_column(row, 4)?,
        plan_summary: row.get(5)?,
        source_revision: row.get(6)?,
        base_head: row.get(7)?,
        integration_branch: row.get(8)?,
        integration_worktree: row.get(9)?,
        final_commit: row.get(10)?,
        rescue_used: row.get(11)?,
        rescue_attempt_id: row.get(12)?,
        blocked_reason: row.get(13)?,
        paused_operation: parse_optional_json_column(row, 14)?,
        replaces_run_id: row.get(15)?,
        created_at: parse_datetime_column(row, 16)?,
        updated_at: parse_datetime_column(row, 17)?,
        completed_at: parse_optional_datetime_column(row, 18)?,
    })
}

fn read_work_item(row: &Row<'_>) -> rusqlite::Result<WorkItem> {
    Ok(WorkItem {
        id: row.get(0)?,
        run_id: row.get(1)?,
        position: row.get(2)?,
        objective: row.get(3)?,
        scenario_refs: parse_json_column(row, 4)?,
        group: row.get(5)?,
        scope_hints: parse_json_column(row, 6)?,
        verification_goals: parse_json_column(row, 7)?,
        status: parse_json_column(row, 8)?,
        attempt_count: row.get(9)?,
        actual_attempt_count: 0,
        accepted_attempt_id: row.get(10)?,
        created_at: parse_datetime_column(row, 11)?,
        updated_at: parse_datetime_column(row, 12)?,
    })
}

fn read_attempt(row: &Row<'_>) -> rusqlite::Result<WorkflowAttempt> {
    Ok(WorkflowAttempt {
        id: row.get(0)?,
        run_id: row.get(1)?,
        work_item_id: row.get(2)?,
        kind: parse_json_column(row, 3)?,
        ordinal: row.get(4)?,
        status: parse_json_column(row, 5)?,
        model_tier: row.get(6)?,
        pi_session_file: row.get(7)?,
        worktree_fingerprint: row.get(8)?,
        result_summary: row.get(9)?,
        failure_class: parse_optional_json_column(row, 10)?,
        failure_message: row.get(11)?,
        usage: parse_optional_json_column(row, 12)?,
        started_at: parse_datetime_column(row, 13)?,
        completed_at: parse_optional_datetime_column(row, 14)?,
    })
}

fn read_checkpoint(row: &Row<'_>) -> rusqlite::Result<WorkflowCheckpoint> {
    Ok(WorkflowCheckpoint {
        id: row.get(0)?,
        run_id: row.get(1)?,
        kind: parse_json_column(row, 2)?,
        revision: row.get(3)?,
        status: parse_json_column(row, 4)?,
        snapshot_sha: row.get(5)?,
        required_angles: parse_json_column(row, 6)?,
        summary: row.get(7)?,
        review_details: parse_optional_json_column(row, 8)?,
        usage: parse_optional_json_column(row, 9)?,
        created_at: parse_datetime_column(row, 10)?,
        updated_at: parse_datetime_column(row, 11)?,
        completed_at: parse_optional_datetime_column(row, 12)?,
    })
}

fn read_validation(row: &Row<'_>) -> rusqlite::Result<WorkflowValidation> {
    Ok(WorkflowValidation {
        id: row.get(0)?,
        run_id: row.get(1)?,
        attempt_id: row.get(2)?,
        checkpoint_id: row.get(3)?,
        command: row.get(4)?,
        source: parse_json_column(row, 5)?,
        gating: row.get(6)?,
        baseline_status: parse_json_column(row, 7)?,
        final_status: parse_json_column(row, 8)?,
        baseline_exit_code: row.get(9)?,
        final_exit_code: row.get(10)?,
        output_summary: row.get(11)?,
        worktree_fingerprint: row.get(12)?,
        created_at: parse_datetime_column(row, 13)?,
        completed_at: parse_optional_datetime_column(row, 14)?,
    })
}

fn read_finding(row: &Row<'_>) -> rusqlite::Result<WorkflowReviewFinding> {
    let path = row
        .get::<_, Option<String>>(6)?
        .filter(|value| !value.is_empty());
    let location = row
        .get::<_, Option<String>>(7)?
        .filter(|value| !value.is_empty());
    Ok(WorkflowReviewFinding {
        id: row.get(0)?,
        checkpoint_id: row.get(1)?,
        angle: parse_json_column(row, 2)?,
        priority: parse_json_column(row, 3)?,
        status: parse_json_column(row, 4)?,
        category: row.get(5)?,
        path,
        location,
        summary: row.get(8)?,
        evidence: row.get(9)?,
        reproduction: row.get(10)?,
        remediation: row.get(11)?,
        scenario_ref: row.get(12)?,
        created_at: parse_datetime_column(row, 13)?,
        updated_at: parse_datetime_column(row, 14)?,
    })
}

fn read_publication(row: &Row<'_>) -> rusqlite::Result<WorkflowPublication> {
    Ok(WorkflowPublication {
        run_id: row.get(0)?,
        mode: parse_json_column(row, 1)?,
        provider: parse_json_column(row, 2)?,
        phase: parse_json_column(row, 3)?,
        origin: row.get(4)?,
        target_branch: row.get(5)?,
        source_branch: row.get(6)?,
        review_url: row.get(7)?,
        head_commit: row.get(8)?,
        merge_commit: row.get(9)?,
        local_sync_status: parse_json_column(row, 10)?,
        local_sync_message: row.get(11)?,
        cleanup_status: parse_json_column(row, 12)?,
        remote_ci_fix_used: row.get(13)?,
        last_error: row.get(14)?,
        updated_at: parse_datetime_column(row, 15)?,
    })
}

fn read_item_workspace(row: &Row<'_>) -> rusqlite::Result<WorkflowItemWorkspace> {
    Ok(WorkflowItemWorkspace {
        work_item_id: row.get(0)?,
        run_id: row.get(1)?,
        branch: row.get(2)?,
        worktree_path: row.get(3)?,
        base_commit: row.get(4)?,
        result_commit: row.get(5)?,
        status: parse_json_column(row, 6)?,
        fallback_serial: row.get(7)?,
        updated_at: parse_datetime_column(row, 8)?,
    })
}

fn read_event(row: &Row<'_>) -> rusqlite::Result<WorkflowEvent> {
    Ok(WorkflowEvent {
        sequence: row.get(0)?,
        run_id: row.get(1)?,
        entity_type: row.get(2)?,
        entity_id: row.get(3)?,
        event_type: row.get(4)?,
        payload: parse_json_column(row, 5)?,
        created_at: parse_datetime_column(row, 6)?,
    })
}

fn parse_json_column<T: DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    let text = row.get::<_, String>(index)?;
    serde_json::from_str(&text)
        .or_else(|_| serde_json::from_str(&format!("\"{text}\"")))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
}

fn parse_optional_json_column<T: DeserializeOwned>(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<T>> {
    row.get::<_, Option<String>>(index)?
        .map(|text| {
            serde_json::from_str(&text)
                .or_else(|_| serde_json::from_str(&format!("\"{text}\"")))
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        index,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
        })
        .transpose()
}

fn parse_datetime_column(row: &Row<'_>, index: usize) -> rusqlite::Result<DateTime<Utc>> {
    let text = row.get::<_, String>(index)?;
    DateTime::parse_from_rfc3339(&text)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
}

fn parse_optional_datetime_column(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<DateTime<Utc>>> {
    row.get::<_, Option<String>>(index)?
        .map(|text| DateTime::parse_from_rfc3339(&text).map(|value| value.with_timezone(&Utc)))
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
}

fn to_json_string<T: Serialize>(value: &T) -> Result<String, AppError> {
    Ok(serde_json::to_string(value)?.trim_matches('"').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AcceptanceScenario, ChangeSpec};
    use crate::store::db::Database;
    use crate::workflow::FindingPriority;
    use crate::workflow::{
        PlannedWorkItem, WorkItemStatus, WorkPlan, clone_workflow_for_clean_restart,
        compile_work_plan,
    };

    fn compiled_workflow() -> CompiledWorkflow {
        compile_work_plan(
            "requirement-1",
            1,
            ChangeSpec {
                intent: "完成行为".to_owned(),
                acceptance_scenarios: vec![AcceptanceScenario {
                    id: "scenario-1".to_owned(),
                    given: "初始状态成立".to_owned(),
                    when: "用户执行操作".to_owned(),
                    then: "行为完成".to_owned(),
                }],
                explicit_constraints: Vec::new(),
                non_goals: Vec::new(),
            },
            WorkPlan {
                summary: "plan".to_owned(),
                design_notes: Vec::new(),
                work_items: vec![PlannedWorkItem {
                    id: "item-1".to_owned(),
                    objective: "交付行为".to_owned(),
                    scenario_refs: vec!["scenario-1".to_owned()],
                    depends_on: Vec::new(),
                    group: None,
                    scope_hints: Vec::new(),
                    verification_goals: vec!["行为可观察".to_owned()],
                }],
            },
        )
        .unwrap()
    }

    fn workflow_database() -> (tempfile::TempDir, Database, CompiledWorkflow) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("data.db")).unwrap();
        database
            .lock_connection()
            .execute(
                "INSERT INTO requirements
                 (id, title, status,
                  clarification_round, clarifications, analysis_revision,
                  clarification_history, created_at, updated_at, origin)
                 VALUES ('requirement-1','test','running',0,'[]',1,'[]',?1,?1,'standalone')",
                [Utc::now().to_rfc3339()],
            )
            .unwrap();
        let workflow = compiled_workflow();
        database.create_workflow(&workflow).unwrap();
        (directory, database, workflow)
    }

    #[test]
    fn priority_deduplication_keeps_the_more_important_finding() {
        let now = Utc::now();
        let finding = |id: &str, priority| WorkflowReviewFinding {
            id: id.to_owned(),
            checkpoint_id: "checkpoint".to_owned(),
            angle: ReviewAngle::Correctness,
            priority,
            status: super::super::FindingStatus::Open,
            category: "regression".to_owned(),
            path: Some("src/lib.rs".to_owned()),
            location: Some("10".to_owned()),
            summary: id.to_owned(),
            evidence: "evidence".to_owned(),
            reproduction: None,
            remediation: None,
            scenario_ref: None,
            created_at: now,
            updated_at: now,
        };
        let mut map = HashMap::new();
        for current in [
            finding("p2", FindingPriority::P2),
            finding("p1", FindingPriority::P1),
        ] {
            let key = (
                current.angle,
                current.category.clone(),
                current.path.clone(),
                current.location.clone(),
            );
            map.entry(key)
                .and_modify(|saved: &mut WorkflowReviewFinding| {
                    if current.priority < saved.priority {
                        *saved = current.clone();
                    }
                })
                .or_insert(current);
        }
        assert_eq!(
            map.into_values().next().unwrap().priority,
            FindingPriority::P1
        );
    }

    #[test]
    fn publication_configuration_is_frozen_and_item_paths_are_not_serialized() {
        let (_directory, database, workflow) = workflow_database();
        let now = Utc::now();
        let publication = WorkflowPublication {
            run_id: workflow.run.id.clone(),
            mode: crate::workflow::WorkflowPublicationMode::PullRequest,
            provider: crate::workflow::WorkflowPublicationProvider::GitHub,
            phase: crate::workflow::WorkflowPublicationPhase::Prepared,
            origin: "git@github.com:acme/repo.git".to_owned(),
            target_branch: "main".to_owned(),
            source_branch: format!("raccoon/workflow-{}", workflow.run.id),
            review_url: None,
            head_commit: None,
            merge_commit: None,
            local_sync_status: crate::workflow::WorkflowLocalSyncStatus::Pending,
            local_sync_message: None,
            cleanup_status: crate::workflow::WorkflowCleanupStatus::Pending,
            remote_ci_fix_used: false,
            last_error: None,
            updated_at: now,
        };
        database.ensure_workflow_publication(&publication).unwrap();
        let mut changed = publication.clone();
        changed.target_branch = "develop".to_owned();
        let frozen = database.ensure_workflow_publication(&changed).unwrap();
        assert_eq!(frozen.target_branch, "main");

        database
            .upsert_workflow_item_workspace(
                &WorkflowItemWorkspace {
                    work_item_id: workflow.work_items[0].id.clone(),
                    run_id: workflow.run.id.clone(),
                    branch: format!("raccoon/workflow-{}-item-000", workflow.run.id),
                    worktree_path: "/secret/managed/item".to_owned(),
                    base_commit: "base".to_owned(),
                    result_commit: None,
                    status: crate::workflow::WorkflowItemWorkspaceStatus::Prepared,
                    fallback_serial: false,
                    updated_at: now,
                },
                "item_workspace.prepared",
            )
            .unwrap();
        let json =
            serde_json::to_string(&database.workflow_snapshot(&workflow.run.id).unwrap()).unwrap();
        assert!(!json.contains("/secret/managed/item"));
    }

    #[test]
    fn technical_partial_review_keeps_completed_angle_findings_until_rechecked() {
        let (_directory, database, workflow) = workflow_database();
        let first = database
            .create_checkpoint(
                &workflow.run.id,
                CheckpointKind::Final,
                "git:first",
                &[ReviewAngle::Correctness, ReviewAngle::Security],
            )
            .unwrap();
        let now = Utc::now();
        database
            .store_review_findings(
                &first.id,
                &[WorkflowReviewFinding {
                    id: "correctness-blocker".to_owned(),
                    checkpoint_id: first.id.clone(),
                    angle: ReviewAngle::Correctness,
                    priority: FindingPriority::P1,
                    status: FindingStatus::Open,
                    category: "regression".to_owned(),
                    path: Some("src/lib.rs".to_owned()),
                    location: Some("run".to_owned()),
                    summary: "behavior fails".to_owned(),
                    evidence: "reproducible".to_owned(),
                    reproduction: None,
                    remediation: None,
                    scenario_ref: Some("scenario-1".to_owned()),
                    created_at: now,
                    updated_at: now,
                }],
                &[ReviewAngle::Correctness],
            )
            .unwrap();
        database
            .finish_checkpoint(
                &first.id,
                CheckpointStatus::TechnicalFailure,
                "security failed",
            )
            .unwrap();
        let retry = database
            .create_checkpoint(
                &workflow.run.id,
                CheckpointKind::Final,
                "git:first",
                &[ReviewAngle::Security],
            )
            .unwrap();
        database
            .store_review_findings(&retry.id, &[], &[ReviewAngle::Security])
            .unwrap();
        database
            .finish_checkpoint(&retry.id, CheckpointStatus::Approved, "security passed")
            .unwrap();

        let snapshot = database.workflow_snapshot(&workflow.run.id).unwrap();
        assert!(snapshot.findings.iter().any(|finding| {
            finding.id == "correctness-blocker" && finding.status == FindingStatus::Open
        }));
    }

    #[test]
    fn technical_work_item_failure_does_not_consume_semantic_attempt() {
        let (_directory, database, workflow) = workflow_database();
        let item = database
            .runnable_work_items(&workflow.run.id, 1)
            .unwrap()
            .remove(0);
        let attempt = database
            .start_workflow_attempt(
                &workflow.run.id,
                Some(&item.id),
                WorkflowAttemptKind::Implementation,
                "low",
            )
            .unwrap();
        database
            .finish_workflow_attempt(
                &attempt.id,
                false,
                None,
                None,
                None,
                Some(FailureClass::AgentRuntime),
                Some("RPC exited"),
                None,
            )
            .unwrap();

        let snapshot = database.workflow_snapshot(&workflow.run.id).unwrap();
        assert_eq!(
            snapshot.work_items[0].status,
            super::super::WorkItemStatus::Pending
        );
        assert_eq!(snapshot.work_items[0].attempt_count, 0);
        assert_eq!(snapshot.work_items[0].actual_attempt_count, 1);
    }

    #[test]
    fn superseded_attempt_preserves_usage_and_actual_call_count() {
        let (_directory, database, workflow) = workflow_database();
        let item = database
            .runnable_work_items(&workflow.run.id, 1)
            .unwrap()
            .remove(0);
        let attempt = database
            .start_workflow_attempt(
                &workflow.run.id,
                Some(&item.id),
                WorkflowAttemptKind::Implementation,
                "low",
            )
            .unwrap();
        let usage = json!({
            "trace": {
                "usage": {"scope": "operation", "input": 750000, "output": 1000}
            }
        });
        database
            .supersede_workflow_attempt(
                &attempt.id,
                "parallel overlap",
                Some("session.jsonl"),
                Some("git:item"),
                Some("completed work"),
                Some(&usage),
            )
            .unwrap();

        let snapshot = database.workflow_snapshot(&workflow.run.id).unwrap();
        assert_eq!(
            snapshot.attempts[0].status,
            WorkflowAttemptStatus::Superseded
        );
        assert_eq!(
            snapshot.attempts[0]
                .usage
                .as_ref()
                .map(|metrics| metrics.usage.input),
            Some(750_000)
        );
        assert_eq!(snapshot.work_items[0].attempt_count, 0);
        assert_eq!(snapshot.work_items[0].actual_attempt_count, 1);
    }

    #[test]
    fn deterministic_failure_fuse_is_scoped_to_item_and_integration_fingerprint() {
        let (_directory, database, workflow) = workflow_database();
        let item_id = &workflow.work_items[0].id;
        database
            .record_workflow_failure_fuse(
                &workflow.run.id,
                item_id,
                FailureClass::WorkspaceViolation,
                "git:integration-a",
            )
            .unwrap();
        assert_eq!(
            database
                .workflow_failure_fuse(item_id, "git:integration-a")
                .unwrap(),
            Some(FailureClass::WorkspaceViolation)
        );
        assert_eq!(
            database
                .workflow_failure_fuse(item_id, "git:integration-b")
                .unwrap(),
            None
        );
    }

    #[test]
    fn clean_restart_is_idempotent_and_preserves_the_discarded_run() {
        let (_directory, database, workflow) = workflow_database();
        database
            .pause_workflow_run(
                &workflow.run.id,
                PausedOperation::WorkspaceViolation.as_str(),
                "dirty integration",
            )
            .unwrap();
        assert!(database.resume_workflow_run(&workflow.run.id).is_err());
        let original = database.workflow_snapshot(&workflow.run.id).unwrap();
        let replacement = clone_workflow_for_clean_restart(&original);
        let replacement_id = database
            .restart_workflow_clean(&workflow.run.id, &replacement)
            .unwrap();
        assert_eq!(replacement_id, replacement.run.id);
        assert_eq!(
            database
                .restart_workflow_clean(&workflow.run.id, &replacement)
                .unwrap(),
            replacement_id
        );

        let old = database.workflow_snapshot(&workflow.run.id).unwrap();
        assert_eq!(old.run.status, WorkflowRunStatus::Cancelled);
        let restarted = database.workflow_snapshot(&replacement_id).unwrap();
        assert_eq!(
            restarted.run.replaces_run_id.as_deref(),
            Some(workflow.run.id.as_str())
        );
        assert!(restarted.attempts.is_empty());
        assert!(
            restarted
                .work_items
                .iter()
                .all(|item| item.status == WorkItemStatus::Pending)
        );
    }

    #[test]
    fn technical_pause_normalizes_an_unfinished_attempt_for_resume() {
        let (_directory, database, workflow) = workflow_database();
        let item = database
            .runnable_work_items(&workflow.run.id, 1)
            .unwrap()
            .remove(0);
        database
            .start_workflow_attempt(
                &workflow.run.id,
                Some(&item.id),
                WorkflowAttemptKind::Implementation,
                "low",
            )
            .unwrap();

        database
            .pause_workflow_run(
                &workflow.run.id,
                PausedOperation::PersistAttempt.as_str(),
                "database busy",
            )
            .unwrap();

        let snapshot = database.workflow_snapshot(&workflow.run.id).unwrap();
        assert_eq!(
            snapshot.work_items[0].status,
            super::super::WorkItemStatus::Pending
        );
        assert_eq!(snapshot.work_items[0].attempt_count, 0);
        assert_eq!(snapshot.attempts[0].status, WorkflowAttemptStatus::Failed);
        assert_eq!(
            snapshot.attempts[0].failure_class,
            Some(FailureClass::Infrastructure)
        );
    }

    #[test]
    fn technical_rescue_failure_releases_the_single_rescue_slot() {
        let (_directory, database, workflow) = workflow_database();
        let rescue = database
            .begin_run_rescue(&workflow.run.id, "semantic exhaustion")
            .unwrap();
        database
            .finish_workflow_attempt(
                &rescue.id,
                false,
                None,
                None,
                None,
                Some(FailureClass::AgentRuntime),
                Some("Pi exited"),
                None,
            )
            .unwrap();

        let snapshot = database.workflow_snapshot(&workflow.run.id).unwrap();
        assert!(!snapshot.run.rescue_used);
        assert!(snapshot.run.rescue_attempt_id.is_none());
    }

    #[test]
    fn technical_rescue_feedback_failure_preserves_the_used_rescue_slot() {
        let (_directory, database, workflow) = workflow_database();
        let rescue = database
            .begin_run_rescue(&workflow.run.id, "semantic exhaustion")
            .unwrap();
        database
            .finish_workflow_attempt(
                &rescue.id,
                true,
                Some("rescue-session.jsonl"),
                Some("git:first"),
                Some("first rescue turn completed"),
                None,
                None,
                None,
            )
            .unwrap();
        let feedback = database
            .start_workflow_attempt(&workflow.run.id, None, WorkflowAttemptKind::Rescue, "high")
            .unwrap();
        database
            .finish_workflow_attempt(
                &feedback.id,
                false,
                None,
                None,
                None,
                Some(FailureClass::AgentRuntime),
                Some("Pi exited during feedback"),
                None,
            )
            .unwrap();

        let snapshot = database.workflow_snapshot(&workflow.run.id).unwrap();
        assert!(snapshot.run.rescue_used);
        assert_eq!(
            snapshot.run.rescue_attempt_id.as_deref(),
            Some(rescue.id.as_str())
        );
    }

    #[test]
    fn process_restart_releases_an_unfinished_first_rescue_turn() {
        let (_directory, database, workflow) = workflow_database();
        database
            .begin_run_rescue(&workflow.run.id, "semantic exhaustion")
            .unwrap();

        database.recover_interrupted_workflows().unwrap();

        let snapshot = database.workflow_snapshot(&workflow.run.id).unwrap();
        assert_eq!(snapshot.run.status, WorkflowRunStatus::PausedTechnical);
        assert!(!snapshot.run.rescue_used);
        assert!(snapshot.run.rescue_attempt_id.is_none());
    }

    #[test]
    fn event_pages_are_incremental_and_only_technical_pauses_resume() {
        let (_directory, database, workflow) = workflow_database();
        assert!(database.resume_workflow_run(&workflow.run.id).is_err());
        database
            .pause_workflow_run(
                &workflow.run.id,
                PausedOperation::Review.as_str(),
                "protocol error",
            )
            .unwrap();

        let first = database
            .workflow_events(&workflow.run.id, 0, Some(1))
            .unwrap();
        assert_eq!(first.events.len(), 1);
        assert!(first.next_after.is_some());
        let rest = database
            .workflow_events(&workflow.run.id, first.next_after.unwrap(), Some(100))
            .unwrap();
        assert!(!rest.events.is_empty());

        assert_eq!(
            database.resume_workflow_run(&workflow.run.id).unwrap(),
            PausedOperation::Review
        );
        assert_eq!(
            database
                .workflow_snapshot(&workflow.run.id)
                .unwrap()
                .run
                .status,
            WorkflowRunStatus::Running
        );
        assert_eq!(
            database
                .workflow_snapshot(&workflow.run.id)
                .unwrap()
                .run
                .paused_operation,
            Some(PausedOperation::Review)
        );
    }
}
