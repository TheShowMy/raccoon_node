use std::fmt::Write;

use serde::Serialize;

use crate::models::{ChangeSpec, Requirement};
use crate::prompt::{
    PromptRenderer, PromptSourceKind, RenderedPrompt, SectionKind, format_section,
    strip_markdown_frontmatter, truncate_chars,
};

use super::{
    FindingStatus, ReviewAngle, WorkflowAgentInput, WorkflowAttemptKind, WorkflowPlanInput,
    WorkflowReviewInput,
};

const GLOBAL_PROMPT: &str = include_str!("../../prompts/global/raccoon.md");
const MAX_ATTEMPT_PACKET_CHARS: usize = 16_000;
const MAX_RESCUE_PACKET_CHARS: usize = 24_000;

pub fn build_workflow_plan_prompt(input: &WorkflowPlanInput) -> RenderedPrompt {
    let requirement = format_requirement(&input.requirement);
    let policy = r#"生成 OpenSpec 风格 WorkPlan：
- work_items 只能是可交付的行为切片，不得创建审核、总结、合并、恢复、检查、等待或 Stage。
- 每项只提交 id、objective、scenario_refs、depends_on、可选 group、scope_hints 和 verification_goals。
- scenario_refs 必须覆盖 ChangeSpec 的全部行为场景；不得复制或改写场景内容。
- scope_hints 只提供安全仓库相对路径线索，不是机械写入限制；不确定时使用空数组。
- verification_goals 描述要验证的结果，禁止提交 shell 命令、grep/rg 或字符串计数。
- 技术选择只放 design_notes，并附仓库证据与理由；DesignNotes 可在实现时修订，不是验收条件。
- 默认串行依赖。只有范围明确且互不重叠时才允许使用同一 group 表示可并行。
- 完成后只调用 submit_work_plan。"#;

    PromptRenderer::new("workflow_planner_v5")
        .add_source(PromptSourceKind::Global, "raccoon", GLOBAL_PROMPT)
        .add_source(
            PromptSourceKind::Skill,
            "execution_planner",
            strip_markdown_frontmatter(include_str!("../../prompts/skills/execution_planner.md")),
        )
        .add_source(
            PromptSourceKind::InlinePolicy,
            "work_plan_v5_policy",
            policy,
        )
        .add_source(
            PromptSourceKind::RequirementContext,
            "change_spec",
            requirement,
        )
        .render()
}

pub fn build_workflow_attempt_prompt(input: &WorkflowAgentInput) -> RenderedPrompt {
    let is_rescue = input.attempt_kind == WorkflowAttemptKind::Rescue;
    let is_continuation = input.continuation_feedback.is_some();
    let is_fix = matches!(
        input.attempt_kind,
        WorkflowAttemptKind::Fix | WorkflowAttemptKind::IntegrationFix
    );
    let mut packet = String::new();
    if let Some(feedback) = &input.continuation_feedback {
        let _ = writeln!(packet, "## 本轮反馈\n{}", truncate_chars(feedback, 4_000).0);
    }
    let _ = writeln!(packet, "## WorkflowRun\n- run_id: {}", input.run.id);
    if is_continuation {
        // The existing Pi session already contains the ChangeSpec and first Rescue turn.
    } else if is_rescue || input.attempt_kind == WorkflowAttemptKind::IntegrationFix {
        append_json(
            &mut packet,
            "行为场景",
            &input.run.change_spec.acceptance_scenarios,
        );
        append_json(
            &mut packet,
            "用户显式约束",
            &input.run.change_spec.explicit_constraints,
        );
    } else if let Some(item) = &input.work_item {
        let scenarios = input
            .run
            .change_spec
            .acceptance_scenarios
            .iter()
            .filter(|scenario| item.scenario_refs.contains(&scenario.id))
            .collect::<Vec<_>>();
        let _ = writeln!(
            packet,
            "- work_item_id: {}\n- objective: {}",
            item.id, item.objective
        );
        append_json(&mut packet, "关联行为场景", &scenarios);
        append_json(
            &mut packet,
            "用户显式约束",
            &input.run.change_spec.explicit_constraints,
        );
        if !is_fix {
            append_json(&mut packet, "可修订 DesignNotes", &input.run.design_notes);
            append_json(&mut packet, "范围线索", &item.scope_hints);
            append_json(&mut packet, "验证目标", &item.verification_goals);
        }
    }
    let blockers = input
        .open_blockers
        .iter()
        .filter(|finding| finding.priority.is_blocking() && finding.status == FindingStatus::Open)
        .map(|finding| {
            serde_json::json!({
                "priority": finding.priority,
                "path": finding.path,
                "location": finding.location,
                "summary": finding.summary,
                "remediation": finding.remediation,
                "scenario_ref": finding.scenario_ref,
            })
        })
        .collect::<Vec<_>>();
    if !is_continuation {
        append_json(&mut packet, "当前 P0/P1 阻断项", &blockers);
    }
    let failures = input
        .recent_failures
        .iter()
        .rev()
        .take(if is_rescue { 10 } else { 3 })
        .map(|attempt| {
            serde_json::json!({
                "kind": attempt.kind,
                "work_item_id": attempt.work_item_id,
                "class": attempt.failure_class,
                "message": attempt.failure_message,
            })
        })
        .collect::<Vec<_>>();
    if !is_continuation {
        append_json(&mut packet, "精简失败链", &failures);
    }
    let validations = input
        .validation_evidence
        .iter()
        .rev()
        .take(if is_rescue { 12 } else { 6 })
        .map(|validation| {
            serde_json::json!({
                "command": validation.command,
                "source": validation.source,
                "gating": validation.gating,
                "baseline_status": validation.baseline_status,
                "final_status": validation.final_status,
                "summary": validation.output_summary,
                "fingerprint": validation.worktree_fingerprint,
            })
        })
        .collect::<Vec<_>>();
    if !is_continuation {
        append_json(&mut packet, "验证差异", &validations);
    }
    let packet = truncate_chars(
        &packet,
        if is_rescue {
            MAX_RESCUE_PACKET_CHARS
        } else {
            MAX_ATTEMPT_PACKET_CHARS
        },
    )
    .0;
    let policy = if is_continuation {
        "这是同一个 Rescue 会话的唯一反馈轮。只根据本轮原生验证失败证据修正现有改动，不要重新探索需求或扩大范围。完成后调用 submit_workflow_result。"
    } else if is_rescue {
        "这是本 WorkflowRun 唯一一次外部高级 Rescue。基于行为场景、当前完整 diff、未关闭 P0/P1、验证差异和精简失败链直接修复；不要复述长历史。完成后以 outcome=completed 或 blocked 调用 submit_workflow_result。"
    } else if is_fix {
        "只处理当前 P0/P1 remediation，并保持行为场景成立。不要处理 advisory 或扩大范围。完成后以 outcome=completed 或 blocked 调用 submit_workflow_result。"
    } else {
        "完成当前行为切片。先读取仓库确认 DesignNotes 是否适用；可采用更合适的等价实现，不要把 DesignNotes 当作机械验收。完成后以 outcome=completed 或 blocked 调用 submit_workflow_result。"
    };

    PromptRenderer::new(if is_rescue {
        "workflow_rescue_v5"
    } else if is_fix {
        "workflow_fix_v5"
    } else {
        "workflow_attempt_v5"
    })
    .add_source(PromptSourceKind::Global, "raccoon", GLOBAL_PROMPT)
    .add_source(PromptSourceKind::InlinePolicy, "attempt_policy", policy)
    .add_source(PromptSourceKind::TaskContext, "attempt_packet", packet)
    .render()
}

pub fn build_workflow_review_prompt(input: &WorkflowReviewInput) -> RenderedPrompt {
    let contract = serde_json::to_string(&serde_json::json!({
        "change_spec": input.run.change_spec,
    }))
    .expect("serializable review contract");
    let evidence = serde_json::to_string(&serde_json::json!({
        "checkpoint": {
            "id": input.checkpoint.id,
            "kind": input.checkpoint.kind,
            "snapshot_sha": input.checkpoint.snapshot_sha,
            "required_angles": input.checkpoint.required_angles,
        },
        "validation_evidence": input.validation_evidence.iter().map(|validation| serde_json::json!({
            "command": validation.command,
            "source": validation.source,
            "gating": validation.gating,
            "baseline_status": validation.baseline_status,
            "final_status": validation.final_status,
            "summary": validation.output_summary,
            "fingerprint": validation.worktree_fingerprint,
        })).collect::<Vec<_>>(),
    }))
    .expect("serializable review evidence");
    let prior = input
        .prior_findings
        .iter()
        .filter(|finding| finding.status == FindingStatus::Open)
        .map(|finding| {
            serde_json::json!({
                "angle": review_angle_label(finding.angle),
                "priority": finding.priority,
                "category": finding.category,
                "path": finding.path,
                "location": finding.location,
                "summary": finding.summary,
            })
        })
        .collect::<Vec<_>>();
    let snapshot = serde_json::json!({
        "mode": "range",
        "base": input.run.base_head.as_deref().unwrap_or_default(),
        "angles": input.checkpoint.required_angles.iter().copied().map(review_angle_label).collect::<Vec<_>>(),
    });
    let policy = format_section(
        SectionKind::Managed,
        "review-policy",
        strip_markdown_frontmatter(include_str!("../../prompts/skills/code_reviewer.md")),
    )
    .expect("static review policy section is valid");
    let contract = format_section(SectionKind::Managed, "review-contract", &contract)
        .expect("review contract section is valid");
    let evidence = format_section(SectionKind::Managed, "review-evidence", &evidence)
        .expect("review evidence section is valid");
    let prior = format_section(
        SectionKind::Managed,
        "review-prior",
        &serde_json::to_string(&prior).expect("review prior serializes"),
    )
    .expect("review prior section is valid");
    let snapshot = format_section(
        SectionKind::Managed,
        "review-snapshot",
        &snapshot.to_string(),
    )
    .expect("review snapshot section is valid");

    PromptRenderer::new("workflow_final_review_v5")
        .add_source(PromptSourceKind::Global, "raccoon", GLOBAL_PROMPT)
        .add_source(PromptSourceKind::Skill, "code_reviewer", policy)
        .add_source(PromptSourceKind::TaskContext, "review_contract", contract)
        .add_source(
            PromptSourceKind::ExecutionContext,
            "review_evidence",
            evidence,
        )
        .add_source(PromptSourceKind::ExecutionContext, "review_prior", prior)
        .add_source(
            PromptSourceKind::ExecutionContext,
            "review_snapshot",
            snapshot,
        )
        .render()
}

pub fn review_angle_label(angle: ReviewAngle) -> &'static str {
    match angle {
        ReviewAngle::Correctness => "正确性",
        ReviewAngle::Quality => "代码质量与测试",
        ReviewAngle::Security => "边界与安全",
    }
}

pub fn parse_review_angle(value: &str) -> Option<ReviewAngle> {
    match value {
        "正确性" => Some(ReviewAngle::Correctness),
        "代码质量与测试" => Some(ReviewAngle::Quality),
        "边界与安全" => Some(ReviewAngle::Security),
        _ => None,
    }
}

fn format_requirement(requirement: &Requirement) -> String {
    let mut output = format!("## ChangeSpec\n需求标题：{}\n", requirement.title);
    if let Some(spec) = &requirement.draft {
        output.push_str(&format_change_spec(spec));
    }
    output
}

fn format_change_spec(spec: &ChangeSpec) -> String {
    serde_json::to_string_pretty(spec).expect("ChangeSpec serializes")
}

fn append_json<T: Serialize>(output: &mut String, title: &str, value: &T) {
    let _ = writeln!(output, "\n## {title}");
    output.push_str(&serde_json::to_string(value).expect("serializable context packet"));
    output.push('\n');
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use crate::models::{AcceptanceScenario, RequirementOrigin, RequirementStatus};

    use super::*;

    #[test]
    fn planner_prompt_forbids_stage_and_command_gates() {
        let requirement = Requirement {
            id: "r1".to_owned(),
            project_id: "current".to_owned(),
            title: "需求".to_owned(),
            original_message: "美化主页面".to_owned(),
            origin: RequirementOrigin::Standalone,
            status: RequirementStatus::Planning,
            messages: Vec::new(),
            clarification_round: 0,
            clarifications: Vec::new(),
            draft: Some(ChangeSpec {
                intent: "改善主页面体验".to_owned(),
                acceptance_scenarios: vec![AcceptanceScenario {
                    id: "main".to_owned(),
                    given: "用户打开应用".to_owned(),
                    when: "用户查看主页面".to_owned(),
                    then: "界面清晰现代".to_owned(),
                }],
                explicit_constraints: Vec::new(),
                non_goals: Vec::new(),
            }),
            analysis_revision: 1,
            active_prompt: None,
            clarification_history: Vec::new(),
            pi_session_file: None,
            error: None,
            queued_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let prompt = build_workflow_plan_prompt(&WorkflowPlanInput {
            project: crate::models::Project {
                id: "current".to_owned(),
                name: "repo".to_owned(),
                git_url: String::new(),
                local_path: "/repo".to_owned(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
            requirement,
            model_settings: crate::models::ModelSettings::default(),
        })
        .markdown;
        assert!(prompt.contains("OpenSpec"));
        assert!(prompt.contains("禁止提交 shell 命令"));
        assert!(!prompt.contains("checkpoint_required"));
    }
}
