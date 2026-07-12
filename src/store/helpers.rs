fn runnable_task_indexes(plan: &RequirementExecutionPlan) -> Result<Vec<usize>, AppError> {
    let mut indexes = Vec::new();
    for (index, task) in plan.tasks.iter().enumerate() {
        let runnable_status = matches!(
            task.status,
            RequirementTaskStatus::Pending | RequirementTaskStatus::Fixing
        );
        if !runnable_status {
            continue;
        }
        if matches!(
            task.kind,
            RequirementTaskKind::Review | RequirementTaskKind::ReviewSubAgent
        ) {
            let Some(review_for) = task.review_for.as_deref() else {
                continue;
            };
            let reviewed_ready = plan.tasks.iter().any(|candidate| {
                candidate.id == review_for
                    && candidate.status == RequirementTaskStatus::AwaitingReview
            });
            if reviewed_ready {
                indexes.push(index);
            }
            continue;
        }
        if task.kind == RequirementTaskKind::ReviewSummary {
            if review_sub_agents_finished(plan, task) {
                indexes.push(index);
            }
            continue;
        }

        if dependencies_completed(plan, task) {
            indexes.push(index);
        }
    }
    if !indexes.is_empty() {
        return Ok(indexes);
    }

    if plan
        .tasks
        .iter()
        .any(|task| task.status == RequirementTaskStatus::Running)
    {
        return Ok(Vec::new());
    }

    if plan.tasks.iter().any(|task| {
        matches!(
            task.status,
            RequirementTaskStatus::Pending | RequirementTaskStatus::Fixing
        )
    }) {
        return Err(AppError::internal("执行 DAG 存在无法满足的依赖"));
    }

    Ok(Vec::new())
}

fn dependencies_completed(
    plan: &RequirementExecutionPlan,
    task: &crate::models::RequirementExecutionTask,
) -> bool {
    task.depends_on.iter().all(|dependency| {
        plan.tasks.iter().any(|candidate| {
            candidate.id == *dependency && candidate.status == RequirementTaskStatus::Completed
        })
    })
}

fn review_sub_agents_finished(
    plan: &RequirementExecutionPlan,
    task: &crate::models::RequirementExecutionTask,
) -> bool {
    let Some(review_for) = task.review_for.as_deref() else {
        return false;
    };
    let sub_agents = plan
        .tasks
        .iter()
        .filter(|candidate| {
            candidate.kind == RequirementTaskKind::ReviewSubAgent
                && candidate.review_for.as_deref() == Some(review_for)
        })
        .collect::<Vec<_>>();
    !sub_agents.is_empty()
        && sub_agents.iter().all(|candidate| {
            matches!(
                candidate.status,
                RequirementTaskStatus::Completed | RequirementTaskStatus::Rejected
            )
        })
}

fn rejected_review_sub_agent_feedback(
    plan: &RequirementExecutionPlan,
    task_index: usize,
) -> Option<String> {
    let review_for = plan.tasks[task_index].review_for.as_deref()?;
    plan.tasks
        .iter()
        .find(|task| {
            task.kind == RequirementTaskKind::ReviewSubAgent
                && task.review_for.as_deref() == Some(review_for)
                && task.review_status == RequirementReviewStatus::Rejected
        })
        .map(|task| {
            task.last_review_feedback
                .clone()
                .unwrap_or_else(|| "子审核 Agent 未通过".to_owned())
        })
}

fn begin_review_round(
    plan: &mut RequirementExecutionPlan,
    implementation_id: &str,
    summary: String,
    now: chrono::DateTime<Utc>,
) {
    let Some(task) = plan
        .tasks
        .iter_mut()
        .find(|task| task.id == implementation_id)
    else {
        return;
    };
    task.review_history.push(RequirementReviewRound {
        round: task.review_history.len() as u32 + 1,
        implementation_attempt: task.attempt,
        implementation_summary: summary,
        status: RequirementReviewRoundStatus::Reviewing,
        started_at: now,
        completed_at: None,
        reviews: Vec::new(),
        summary_conclusion: None,
        summary: None,
        failure_reason: None,
    });
}

fn record_review_step(
    plan: &mut RequirementExecutionPlan,
    review_task_id: &str,
    status: RequirementReviewStatus,
    summary: String,
    failure_reason: Option<String>,
    now: chrono::DateTime<Utc>,
) {
    let Some(review) = plan
        .tasks
        .iter()
        .find(|task| task.id == review_task_id)
    else {
        return;
    };
    let Some(implementation_id) = review.review_for.clone() else {
        return;
    };
    let angle = review
        .review_angle
        .clone()
        .unwrap_or_else(|| review.title.clone());
    let Some(round) = plan
        .tasks
        .iter_mut()
        .find(|task| task.id == implementation_id)
        .and_then(|task| task.review_history.last_mut())
    else {
        return;
    };
    let step = RequirementReviewStep {
        task_id: review_task_id.to_owned(),
        angle,
        status,
        summary,
        failure_reason,
        completed_at: now,
    };
    if let Some(previous) = round
        .reviews
        .iter_mut()
        .find(|review| review.task_id == review_task_id)
    {
        *previous = step;
    } else {
        round.reviews.push(step);
    }
}

fn record_parallel_review_steps(
    plan: &mut RequirementExecutionPlan,
    review_task_id: &str,
    trace: Option<&Value>,
    now: chrono::DateTime<Utc>,
) -> bool {
    let Some(items) = trace
        .and_then(|trace| trace.pointer("/trace/parallelReview"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    for item in items {
        let angle = item.get("angle").and_then(Value::as_str).unwrap_or("综合审核");
        let approved = item.get("approved").and_then(Value::as_bool).unwrap_or(false);
        let summary = item
            .get("resultSummary")
            .and_then(Value::as_str)
            .unwrap_or("未提供审核摘要");
        let feedback = item.get("feedback").and_then(Value::as_str);
        let Some(implementation_id) = plan
            .tasks
            .iter()
            .find(|task| task.id == review_task_id)
            .and_then(|task| task.review_for.clone())
        else {
            return false;
        };
        let Some(round) = plan
            .tasks
            .iter_mut()
            .find(|task| task.id == implementation_id)
            .and_then(|task| task.review_history.last_mut())
        else {
            return false;
        };
        round.reviews.push(RequirementReviewStep {
            task_id: format!("{review_task_id}:{angle}"),
            angle: angle.to_owned(),
            status: if approved {
                RequirementReviewStatus::Approved
            } else {
                RequirementReviewStatus::Rejected
            },
            summary: summary.to_owned(),
            failure_reason: (!approved).then(|| feedback.map(str::to_owned)).flatten(),
            completed_at: now,
        });
    }
    true
}

fn finish_review_round(
    plan: &mut RequirementExecutionPlan,
    summary_task_id: &str,
    conclusion: RequirementReviewStatus,
    summary: String,
    failure_reason: Option<String>,
    now: chrono::DateTime<Utc>,
) {
    let Some(implementation_id) = plan
        .tasks
        .iter()
        .find(|task| task.id == summary_task_id)
        .and_then(|task| task.review_for.clone())
    else {
        return;
    };
    let Some(round) = plan
        .tasks
        .iter_mut()
        .find(|task| task.id == implementation_id)
        .and_then(|task| task.review_history.last_mut())
    else {
        return;
    };
    round.status = match conclusion {
        RequirementReviewStatus::Approved => RequirementReviewRoundStatus::Approved,
        RequirementReviewStatus::Rejected => RequirementReviewRoundStatus::Rejected,
        RequirementReviewStatus::Pending => RequirementReviewRoundStatus::Reviewing,
    };
    round.summary_conclusion = Some(conclusion);
    round.summary = Some(summary);
    round.failure_reason = failure_reason;
    if conclusion != RequirementReviewStatus::Pending {
        round.completed_at = Some(now);
    }
}

fn reset_review_for(plan: &mut RequirementExecutionPlan, task_id: &str) {
    for candidate in &mut plan.tasks {
        if candidate.review_for.as_deref() == Some(task_id) {
            candidate.status = RequirementTaskStatus::Pending;
            candidate.review_status = RequirementReviewStatus::Pending;
            candidate.pi_session_file = None;
            candidate.last_review_feedback = None;
            candidate.result_summary = None;
            candidate.trace = None;
            candidate.execution_warning = None;
            candidate.error = None;
        }
    }
}

fn approve_reviewed_task(
    plan: &mut RequirementExecutionPlan,
    review_task_id: &str,
    feedback: Option<String>,
) -> Result<(), AppError> {
    let review_for = plan
        .tasks
        .iter()
        .find(|task| task.id == review_task_id)
        .and_then(|task| task.review_for.clone())
        .ok_or_else(|| AppError::bad_request("审核节点缺少 review_for"))?;
    let task_kind = plan
        .tasks
        .iter()
        .find(|task| task.id == review_task_id)
        .map(|task| task.kind)
        .ok_or_else(|| AppError::bad_request("审核节点不存在"))?;
    let all_reviews_approved = task_kind == RequirementTaskKind::ReviewSummary
        || plan
            .tasks
            .iter()
            .filter(|task| {
                task.kind == RequirementTaskKind::Review
                    && task.review_for.as_deref() == Some(&review_for)
            })
            .all(|task| {
                task.id == review_task_id
                    || (task.status == RequirementTaskStatus::Completed
                        && task.review_status == RequirementReviewStatus::Approved)
            });

    let reviewed = plan
        .tasks
        .iter_mut()
        .find(|task| task.id == review_for)
        .ok_or_else(|| AppError::bad_request("审核目标不存在"))?;
    if all_reviews_approved {
        reviewed.status = RequirementTaskStatus::Completed;
        reviewed.review_status = RequirementReviewStatus::Approved;
    } else {
        reviewed.status = RequirementTaskStatus::AwaitingReview;
    }
    reviewed.last_review_feedback = feedback;
    Ok(())
}

fn reject_reviewed_task(
    plan: &mut RequirementExecutionPlan,
    review_task_id: &str,
    feedback: Option<String>,
) -> Result<(), AppError> {
    let review_for = plan
        .tasks
        .iter()
        .find(|task| task.id == review_task_id)
        .and_then(|task| task.review_for.clone())
        .ok_or_else(|| AppError::bad_request("审核节点缺少 review_for"))?;
    let reviewed_index = plan
        .tasks
        .iter()
        .position(|task| task.id == review_for)
        .ok_or_else(|| AppError::bad_request("审核目标不存在"))?;
    let reviewed = &mut plan.tasks[reviewed_index];
    reviewed.review_rejection_count = reviewed.review_rejection_count.saturating_add(1);
    reviewed.review_status = RequirementReviewStatus::Rejected;
    reviewed.last_review_feedback = feedback;
    match reviewed.review_rejection_count {
        count if count < MAX_REVIEW_REJECTIONS => {
            reviewed.status = RequirementTaskStatus::Fixing;
            reviewed.recovery_stage = RequirementRecoveryStage::None;
        }
        MAX_REVIEW_REJECTIONS => {
            reviewed.status = RequirementTaskStatus::Fixing;
            reviewed.recovery_stage = RequirementRecoveryStage::GuidedRetry;
        }
        count if count == MAX_REVIEW_REJECTIONS + 1 => {
            reviewed.status = RequirementTaskStatus::Fixing;
            reviewed.recovery_stage = RequirementRecoveryStage::HighTierExecution;
        }
        _ => {
            reviewed.status = RequirementTaskStatus::Failed;
            reviewed.recovery_stage = RequirementRecoveryStage::Exhausted;
        }
    }
    for task in &mut plan.tasks {
        if matches!(
            task.kind,
            RequirementTaskKind::Review
                | RequirementTaskKind::ReviewSubAgent
                | RequirementTaskKind::ReviewSummary
        ) && task.review_for.as_deref() == Some(review_for.as_str())
            && task.id != review_task_id
        {
            task.status = RequirementTaskStatus::Pending;
            task.review_status = RequirementReviewStatus::Pending;
            task.error = None;
        }
    }
    Ok(())
}

fn reset_recovery_state(task: &mut crate::models::RequirementExecutionTask) {
    task.execution_failure_count = 0;
    task.review_rejection_count = 0;
    task.recovery_stage = RequirementRecoveryStage::None;
    task.failure_summary = None;
    task.recovery_guidance = None;
    task.high_tier_execution_used = false;
}

fn register_execution_failure(
    task: &mut crate::models::RequirementExecutionTask,
    summary: &str,
    error: &str,
    retryable: bool,
) -> bool {
    task.execution_failure_count = task.execution_failure_count.saturating_add(1);
    task.failure_summary = Some(summary.to_owned());
    task.error = Some(error.to_owned());
    if let Some(stage) = next_execution_recovery_stage(task.execution_failure_count, retryable) {
        task.recovery_stage = stage;
        task.status = if task.kind == RequirementTaskKind::Implementation {
            RequirementTaskStatus::Fixing
        } else {
            RequirementTaskStatus::Pending
        };
        true
    } else {
        task.status = RequirementTaskStatus::Failed;
        task.recovery_stage = RequirementRecoveryStage::Exhausted;
        false
    }
}

fn referenced_pi_session_paths(data: &AppData, session_dir: &Path) -> HashSet<PathBuf> {
    data.requirements
        .iter()
        .flat_map(|requirement| {
            requirement.pi_session_file.iter().chain(
                requirement
                    .execution_plan
                    .iter()
                    .flat_map(|plan| plan.tasks.iter())
                    .filter_map(|task| task.pi_session_file.as_ref()),
            )
        })
        .chain(
            data.project_chats
                .iter()
                .filter_map(|chat| chat.pi_session_file.as_ref()),
        )
        .filter_map(|session_file| {
            let path = PathBuf::from(session_file);
            let resolved = if path.is_absolute() {
                path
            } else {
                session_dir.join(path)
            };
            if ensure_child_path(session_dir, &resolved).is_err() {
                return None;
            }
            Some(std::fs::canonicalize(&resolved).unwrap_or(resolved))
        })
        .collect()
}

fn project_chat_response_from(chat: &ProjectChat) -> ProjectChatResponse {
    ProjectChatResponse {
        project_id: chat.project_id.clone(),
        messages: chat.messages.clone(),
        running: chat.running,
        error: chat.error.clone(),
        updated_at: chat.updated_at,
    }
}

fn execution_can_progress(plan: &RequirementExecutionPlan) -> bool {
    plan.tasks
        .iter()
        .any(|task| task.status == RequirementTaskStatus::Running)
        || runnable_task_indexes(plan).is_ok_and(|indexes| !indexes.is_empty())
}

fn short_failure_summary(error: &AppError) -> String {
    error.to_string().chars().take(240).collect()
}

fn is_retryable_execution_error(error: &AppError) -> bool {
    match error {
        AppError::BadRequest(_) | AppError::NotFound(_) | AppError::Conflict(_) => false,
        AppError::Io(_) | AppError::Json(_) | AppError::Database(_) => true,
        AppError::Internal(message) | AppError::TaskExecution { message, .. } => ![
            "请先在模型设置",
            "模型不存在",
            "路径必须",
            "路径越界",
            "worktree 不存在",
            "aborted",
            "已中止",
            "分支",
            "提交",
            "commit",
        ]
        .iter()
        .any(|marker| message.contains(marker)),
    }
}

fn next_execution_recovery_stage(
    failure_count: u32,
    retryable: bool,
) -> Option<RequirementRecoveryStage> {
    if !retryable || failure_count > MAX_EXECUTION_FAILURES {
        return None;
    }
    Some(match failure_count {
        1 | 2 => RequirementRecoveryStage::AutoRetry,
        3 => RequirementRecoveryStage::GuidedRetry,
        _ => RequirementRecoveryStage::HighTierExecution,
    })
}

fn build_requirement_conversation(requirement: Requirement) -> RequirementConversationResponse {
    let mut items = Vec::new();
    for (index, message) in requirement.messages.iter().enumerate() {
        let id = format!("message-{index}");
        match message.role {
            RequirementMessageRole::User => items.push(RequirementConversationItem::User {
                id,
                text: message.content.clone(),
                references: message.references.clone(),
                images: message.images.clone(),
                created_at: message.created_at,
            }),
            RequirementMessageRole::Assistant => {
                items.push(RequirementConversationItem::Assistant {
                    id,
                    text: message.content.clone(),
                    created_at: message.created_at,
                })
            }
            RequirementMessageRole::System => items.push(RequirementConversationItem::Notice {
                id,
                level: RequirementNoticeLevel::Warn,
                text: message.content.clone(),
                created_at: message.created_at,
            }),
            RequirementMessageRole::Trace => items.push(RequirementConversationItem::Process {
                id,
                title: message.content.clone(),
                status: if requirement.status == RequirementStatus::Failed {
                    RequirementProcessStatus::Error
                } else {
                    RequirementProcessStatus::Done
                },
                metadata: message.metadata.clone(),
                created_at: message.created_at,
            }),
        }
    }

    let prompt = match &requirement.active_prompt {
        Some(RequirementPromptState::Clarification {
            prompt_id,
            revision,
            round,
            questions,
        }) => Some(RequirementConversationPrompt::Clarification {
            round: *round,
            questions: questions.clone(),
            prompt_id: Some(prompt_id.clone()),
            revision: Some(*revision),
        }),
        Some(RequirementPromptState::Confirmation {
            prompt_id,
            revision,
            draft,
        }) => Some(RequirementConversationPrompt::Confirmation {
            draft: draft.clone(),
            prompt_id: Some(prompt_id.clone()),
            revision: Some(*revision),
        }),
        None => match requirement.status {
            RequirementStatus::Clarifying if !requirement.clarifications.is_empty() => {
                Some(RequirementConversationPrompt::Clarification {
                    round: requirement.clarification_round,
                    questions: requirement.clarifications.clone(),
                    prompt_id: None,
                    revision: None,
                })
            }
            RequirementStatus::DraftReady => requirement.draft.clone().map(|draft| {
                RequirementConversationPrompt::Confirmation {
                    draft,
                    prompt_id: None,
                    revision: None,
                }
            }),
            _ => None,
        },
    };

    let running = matches!(
        requirement.status,
        RequirementStatus::Analyzing | RequirementStatus::Planning | RequirementStatus::Running
    );

    if let Some(error) = &requirement.error {
        let has_error_notice = items.iter().any(|item| {
            matches!(
                item,
                RequirementConversationItem::Notice {
                    level: RequirementNoticeLevel::Warn,
                    text,
                    ..
                } if text.contains(error)
            )
        });
        if !has_error_notice {
            items.push(RequirementConversationItem::Notice {
                id: "requirement-error".to_owned(),
                level: RequirementNoticeLevel::Warn,
                text: error.clone(),
                created_at: requirement.updated_at,
            });
        }
    }

    RequirementConversationResponse {
        id: requirement.id,
        project_id: requirement.project_id,
        title: requirement.title,
        status: requirement.status,
        running,
        items,
        prompt,
        error: requirement.error,
        updated_at: requirement.updated_at,
    }
}
