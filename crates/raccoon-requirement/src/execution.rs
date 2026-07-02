use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use raccoon_core::error::AppError;
use raccoon_core::models::{
    Requirement, RequirementDraft, RequirementExecutionPlan, RequirementExecutionTask,
    RequirementModelTier, RequirementRecoveryStage, RequirementReviewStatus,
    RequirementTaskExecutionOutput, RequirementTaskKind, RequirementTaskStatus,
};

const REVIEW_ANGLES: [&str; 3] = ["正确性", "边界与安全", "代码质量与测试"];

pub fn effective_model_tier(kind: RequirementTaskKind) -> RequirementModelTier {
    match kind {
        RequirementTaskKind::Implementation | RequirementTaskKind::ReviewSummary => {
            RequirementModelTier::Low
        }
        RequirementTaskKind::Review
        | RequirementTaskKind::ReviewSubAgent
        | RequirementTaskKind::BranchMerge => RequirementModelTier::Medium,
        RequirementTaskKind::MergeReview => RequirementModelTier::High,
    }
}

pub fn build_requirement_plan_prompt(requirement: &Requirement) -> String {
    let draft = requirement
        .draft
        .as_ref()
        .map(format_draft)
        .unwrap_or_else(|| "当前需求没有确认草案。".to_owned());

    format!(
        r#"你是当前项目的执行规划 Agent。

请根据确认需求草案拆分一个可执行 DAG。你只负责规划，不要修改代码。
Pi Agent 当前工作目录已经是项目仓库根目录。你可以读取仓库结构和相关代码来判断任务边界。
所有可展示内容必须使用简体中文。

输出必须是一个 JSON 对象，不要 Markdown，不要代码块。
JSON 格式：
{{
  "summary": "执行计划摘要",
  "tasks": [
    {{
      "id": "task-1",
      "title": "任务标题",
      "description": "任务目标、边界和完成标准",
      "depends_on": [],
      "target_files": ["可能涉及的文件或目录"]
    }}
  ]
}}

要求：
- tasks 数量 1-10 个。
- id 必须稳定、唯一，只能使用小写字母、数字、短横线和下划线。
- depends_on 只能引用已有任务 id，不能形成环。
- 每个任务必须是写代码实现任务，审核、分支合并和最终合并审核由系统自动补齐。
- 同一阶段可并行的任务必须使用完全相同的 depends_on。
- 并行阶段之后的任务必须等待该阶段全部任务完成，禁止只依赖其中一个并行任务形成单分支串行链。
- 会修改相同文件的任务禁止并行；应合并为一个任务，确需拆分时必须明确串行依赖。
- DAG 必须按“阶段”拆分：串行阶段完成后可以进入一个并行阶段；并行阶段的所有任务全部完成并由系统自动合并后，才能进入下一阶段。
- 例如：`task-1 → task-2 → [task-3, task-4, task-5]（并行）→ 系统合并 → task-6 → [task-7, task-8]（并行）→ 系统合并 → 最终审核`；并行组内每个任务的 depends_on 必须完全相同；不要在 tasks 中生成合并任务，系统自动补齐。
- 禁止生成纯审核、纯校验、纯检查、纯原因分析任务。
- check.js、残留字符串检查、代码质量检查只能作为实现任务的验证标准，不能单独成任务。
- 简单命名、文案、单点修改优先生成 1 个实现任务。
- target_files 不确定时可以使用目录级路径或空数组。
- target_files 只应列出当前任务会实际修改的文件，不要把仅用于读取或校验的文件列入。
- 每个任务必须能产生独立、可审查的 diff；如果两个功能天然必须一起实现，就合并成一个任务，不要硬拆。
- description 必须自包含：即便不参考完整需求，实现者只看描述也能独立完成。
- description 中必须显式列出：1) 本任务要修改什么、产出什么；2) 明确不做什么（尤其是后续任务负责的功能）；3) 修改后必须运行的验证命令或检查项。
- 禁止在 description 中使用“后续任务会处理”“这里先预留”等模糊表述。
- 严禁前置任务提前实现后续任务的功能；骨架/基础结构任务只能创建空容器、类型定义、路由占位；任何业务逻辑必须留给后续任务。

## 确认需求草案
{draft}
"#
    )
}

pub fn parse_requirement_plan(text: &str) -> Result<RequirementExecutionPlan, AppError> {
    let value = extract_json_object(text)?;
    let raw: RawPlan = serde_json::from_value(value)?;
    let implementation_tasks = raw
        .tasks
        .into_iter()
        .enumerate()
        .map(|(index, task)| RequirementExecutionTask {
            id: normalize_task_id(&task.id, index),
            title: task.title.trim().to_owned(),
            description: task.description.trim().to_owned(),
            depends_on: task.depends_on,
            kind: RequirementTaskKind::Implementation,
            model_tier: effective_model_tier(RequirementTaskKind::Implementation),
            timeout_seconds: 90,
            pi_session_file: None,
            branch_name: None,
            worktree_path: None,
            review_for: None,
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
            pull_request_url: None,
            merged_into: None,
            cleanup_summary: None,
            execution_warning: None,
            trace: None,
            status: RequirementTaskStatus::Pending,
            target_files: task.target_files,
            result_summary: None,
            error: None,
        })
        .collect::<Vec<_>>();

    let summary = raw.summary.trim().to_owned();
    if summary.is_empty() {
        return Err(AppError::internal("执行计划摘要为空"));
    }
    if implementation_tasks.is_empty() {
        return Err(AppError::internal("执行计划没有任务"));
    }
    let tasks = expand_execution_tasks(implementation_tasks);
    validate_task_graph(&tasks)?;

    Ok(RequirementExecutionPlan { summary, tasks })
}

fn build_review_sub_agent_prompt(
    _requirement: &Requirement,
    task: &RequirementExecutionTask,
) -> String {
    let angle = task.review_angle.as_deref().unwrap_or("综合审核");
    format!(
        r#"代码审核（{angle}）。只审核 git diff --cached 的改动，无暂存改动则直接通过，不要修改代码。

审核目标：{task_title}

只输出 JSON，不要 Markdown：
{json_contract}
"#,
        angle = angle,
        task_title = task.title,
        json_contract = task_output_json_contract(RequirementTaskKind::ReviewSubAgent),
    )
}

pub fn build_requirement_task_prompt(
    requirement: &Requirement,
    plan: &RequirementExecutionPlan,
    task: &RequirementExecutionTask,
) -> String {
    if task.kind == RequirementTaskKind::ReviewSubAgent {
        return build_review_sub_agent_prompt(requirement, task);
    }

    let draft = if task.kind == RequirementTaskKind::Review
        || task.kind == RequirementTaskKind::ReviewSummary
    {
        "本次审核范围见下方「当前任务」，不要要求实现其他未分配任务的内容。".to_owned()
    } else if task.kind == RequirementTaskKind::Implementation {
        requirement
            .draft
            .as_ref()
            .map(format_requirement_summary_for_task)
            .unwrap_or_else(|| "当前需求没有确认草案。".to_owned())
    } else {
        requirement
            .draft
            .as_ref()
            .map(format_draft)
            .unwrap_or_else(|| "当前需求没有确认草案。".to_owned())
    };
    let completed = direct_dependency_outputs(plan, task);
    let failure_context = execution_failure_context(task);

    let (role, extra) = match task.kind {
        RequirementTaskKind::Implementation => (
            "实现 Agent",
            format!(
                r#"## 任务边界（必须遵守）
- 只实现「当前任务」描述中的内容；禁止实现任何未在本描述中明确列出的功能。
- 只能修改目标文件：{target_files_for_boundary}；禁止改动无关文件。
- 禁止以“预留”“提前准备”“顺便”等理由实现后续任务的功能。
- 若发现当前任务已无需修改，返回 changed=false，并在 no_op_reason 说明验证依据。
{fix_feedback}
{recovery_guidance}"#,
                target_files_for_boundary = if task.target_files.is_empty() {
                    "未限定，但仍不得修改与当前任务无关的文件".to_owned()
                } else {
                    task.target_files.join("、")
                },
                fix_feedback = if task.status == RequirementTaskStatus::Fixing {
                    format!(
                        "\n## 修复要求\n- 当前状态：未提交，改动位于暂存区（git diff --cached）\n- 最新审核反馈：{}\n- 必须针对审核反馈产生实际代码修改，禁止 changed=false 或仅重新描述已有实现。\n- 请在原实现基础上修复问题，不要重做无关内容。",
                        task.last_review_feedback.as_deref().unwrap_or("审核未通过"),
                    )
                } else {
                    String::new()
                },
                recovery_guidance = task
                    .recovery_guidance
                    .as_deref()
                    .map(|guidance| format!(
                        "\n## 高档模型恢复方案\n{guidance}\n\n必须按方案处理，并仍遵守当前任务边界。"
                    ))
                    .unwrap_or_default(),
            ),
        ),
        RequirementTaskKind::Review => (
            "代码审核 Agent",
            format!(
                "请只审核当前工作区暂存区（git diff --cached）的改动，不要审核旧提交，不要修改代码。\n若无暂存改动，直接通过。\n审核角度：{}",
                task.review_angle.as_deref().unwrap_or("综合审核")
            ),
        ),
        RequirementTaskKind::ReviewSubAgent => unreachable!("ReviewSubAgent uses build_review_sub_agent_prompt"),
        RequirementTaskKind::ReviewSummary => (
            "代码审核汇总 Agent",
            format!(
                "请汇总当前工作区暂存区（git diff --cached）的三个审核 Sub Agent 意见。只要任一 Sub Agent 不通过，approved 必须为 false，feedback 和 result_summary 必须明确写审核不通过；禁止状态与文字结论矛盾。若无暂存改动，直接通过。\n{}\n审核角度：{}",
                review_feedback_for_prompt(plan, task.review_for.as_deref()),
                task.review_angle.as_deref().unwrap_or("综合审核")
            ),
        ),
        RequirementTaskKind::BranchMerge => (
            "分支合并 Agent",
            "请合并所有前置分支提交；如有冲突，只做最小必要修复。".to_owned(),
        ),
        RequirementTaskKind::MergeReview => (
            "最终合并审核 Agent",
            "当前独立工作区已包含所有审核通过的前置分支。请只在当前分支运行最终检查，至少运行 npm run check；必要时可以做最小修复。禁止 checkout、switch、merge、rebase、push 或执行 gh pr，最终发布由系统处理。".to_owned(),
        ),
    };
    let json_contract = task_output_json_contract(task.kind);

    format!(
        r#"你是当前项目的{role}。

Pi Agent 当前工作目录已经是当前节点的独立工作空间。请只执行当前任务。
必须遵守项目现有技术栈、目录约束和代码风格。
完成后必须只输出一个 JSON 对象，不要 Markdown，不要代码块。

JSON 格式：
{json_contract}

## 确认需求草案
{draft}

## 已完成前置任务
{completed}

## 当前任务
- 标题：{task_title}
- 描述：{task_description}
- 目标文件：{target_files}
{extra}
{failure_context}
"#,
        role = role,
        json_contract = json_contract,
        task_title = task.title,
        task_description = task.description,
        extra = extra,
        failure_context = failure_context,
        target_files = if task.target_files.is_empty() {
            "未限定".to_owned()
        } else {
            task.target_files.join("、")
        },
        completed = completed
    )
}

fn execution_failure_context(task: &RequirementExecutionTask) -> String {
    if task.execution_failure_count == 0 {
        return String::new();
    }
    format!(
        "\n## 上一轮执行失败\n原因：{}\n摘要：{}\n已有结果：{}\n\n请在当前会话和工作区基础上继续，不要重复已完成工作。",
        task.error.as_deref().unwrap_or("未知"),
        task.failure_summary.as_deref().unwrap_or("无"),
        task.result_summary.as_deref().unwrap_or("无"),
    )
}

pub fn build_recovery_guidance_prompt(task: &RequirementExecutionTask) -> String {
    format!(
        r#"你是任务恢复指导 Agent。只分析，不修改代码。

请根据任务边界、失败原因和审核反馈生成最小可执行恢复方案。
只输出 JSON，不要 Markdown：
{recovery_guidance_json_contract}

任务：{title}
描述：{description}
目标文件：{target_files}
失败原因：{error}
失败摘要：{failure_summary}
审核反馈：{review_feedback}
"#,
        recovery_guidance_json_contract = recovery_guidance_json_contract(),
        title = task.title,
        description = task.description,
        target_files = if task.target_files.is_empty() {
            "未限定".to_owned()
        } else {
            task.target_files.join("、")
        },
        error = task.error.as_deref().unwrap_or("无"),
        failure_summary = task.failure_summary.as_deref().unwrap_or("无"),
        review_feedback = task.last_review_feedback.as_deref().unwrap_or("无"),
    )
}

pub fn build_task_output_json_repair_prompt(
    task: &RequirementExecutionTask,
    parse_error: &str,
    previous_content: &str,
) -> String {
    build_json_repair_prompt(
        "任务结果 JSON",
        parse_error,
        previous_content,
        task_output_json_contract(task.kind),
    )
}

pub fn build_recovery_guidance_json_repair_prompt(
    parse_error: &str,
    previous_content: &str,
) -> String {
    build_json_repair_prompt(
        "恢复指导 JSON",
        parse_error,
        previous_content,
        recovery_guidance_json_contract(),
    )
}

pub fn build_requirement_plan_json_repair_prompt(
    parse_error: &str,
    previous_content: &str,
) -> String {
    build_json_repair_prompt(
        "执行计划 JSON",
        parse_error,
        previous_content,
        requirement_plan_json_contract(),
    )
}

fn build_json_repair_prompt(
    output_name: &str,
    parse_error: &str,
    previous_content: &str,
    json_contract: &str,
) -> String {
    format!(
        r#"上一轮输出无法解析为{output_name}：{parse_error}

请基于同一会话上下文重新输出，不要重新执行任务，不要解释，只输出一个合法 JSON 对象，不要 Markdown，不要代码块。

JSON 格式：
{json_contract}

上一轮输出摘录：
{previous_content}
"#,
        previous_content = json_repair_excerpt(previous_content),
    )
}

fn task_output_json_contract(kind: RequirementTaskKind) -> &'static str {
    match kind {
        RequirementTaskKind::Implementation => {
            r#"{
  "changed": true,
  "no_op_reason": null,
  "result_summary": "本任务完成了什么，涉及哪些关键文件，如何验证"
}"#
        }
        RequirementTaskKind::Review | RequirementTaskKind::ReviewSubAgent => {
            r#"{
  "approved": true,
  "feedback": "审核意见，若不通过必须说明需要如何修复",
  "result_summary": "本次审核结论"
}"#
        }
        RequirementTaskKind::ReviewSummary => {
            r#"{
  "approved": true,
  "feedback": "汇总后的审核意见，若不通过必须说明代码节点需要如何修复",
  "result_summary": "审核汇总结论"
}"#
        }
        RequirementTaskKind::BranchMerge => {
            r#"{
  "result_summary": "本分支合并节点完成了什么，是否处理了冲突，如何验证"
}"#
        }
        RequirementTaskKind::MergeReview => {
            r#"{
  "approved": true,
  "feedback": "最终审核意见",
  "result_summary": "最终合并审核结论"
}"#
        }
    }
}

fn recovery_guidance_json_contract() -> &'static str {
    r#"{
  "root_cause": "根因判断",
  "strategy": "处理策略",
  "steps": ["执行步骤"],
  "verification": ["验证步骤"]
}"#
}

fn requirement_plan_json_contract() -> &'static str {
    r#"{
  "summary": "执行计划摘要",
  "tasks": [
    {
      "id": "task-1",
      "title": "任务标题",
      "description": "任务目标、边界和完成标准",
      "depends_on": [],
      "target_files": ["可能涉及的文件或目录"]
    }
  ]
}"#
}

fn json_repair_excerpt(content: &str) -> String {
    const MAX_CHARS: usize = 4000;
    let trimmed = content.trim();
    let excerpt = trimmed.chars().take(MAX_CHARS).collect::<String>();
    if trimmed.chars().count() > MAX_CHARS {
        format!("{excerpt}\n...（已截断）")
    } else {
        excerpt
    }
}

pub fn parse_recovery_guidance(text: &str) -> Result<String, AppError> {
    let value = extract_json_object(text)?;
    let raw: RawRecoveryGuidance = serde_json::from_value(value)?;
    if raw.root_cause.trim().is_empty() || raw.strategy.trim().is_empty() {
        return Err(AppError::internal("高档模型恢复方案缺少根因或策略"));
    }
    Ok(format!(
        "根因：{}\n策略：{}\n步骤：{}\n验证：{}",
        raw.root_cause.trim(),
        raw.strategy.trim(),
        raw.steps.join("；"),
        raw.verification.join("；")
    ))
}

pub fn parse_task_execution_output(
    text: &str,
    trace: Option<Value>,
) -> Result<RequirementTaskExecutionOutput, AppError> {
    let value = extract_json_object(text)?;
    let raw: RawTaskOutput = serde_json::from_value(value)?;
    let no_op_reason = raw.no_op_reason.map(|reason| reason.trim().to_owned());
    let result_summary = raw
        .result_summary
        .filter(|summary| !summary.trim().is_empty())
        .map(|summary| summary.trim().to_owned())
        .or_else(|| {
            if raw.changed == Some(false) {
                no_op_reason.clone()
            } else {
                None
            }
        });
    let result_summary = match result_summary {
        Some(summary) => summary,
        None => return Err(AppError::internal("任务执行结果摘要为空")),
    };
    Ok(RequirementTaskExecutionOutput {
        result_summary,
        pi_session_file: None,
        branch_name: None,
        worktree_path: None,
        review_status: raw.approved.map(|approved| {
            if approved {
                RequirementReviewStatus::Approved
            } else {
                RequirementReviewStatus::Rejected
            }
        }),
        review_feedback: raw.feedback.map(|feedback| feedback.trim().to_owned()),
        pull_request_url: None,
        merged_into: None,
        cleanup_summary: None,
        execution_warning: None,
        changed: raw.changed,
        no_op_reason,
        recovery_guidance: None,
        trace,
    })
}

fn direct_dependency_outputs(
    plan: &RequirementExecutionPlan,
    task: &RequirementExecutionTask,
) -> String {
    let direct_ids: HashSet<_> = task.depends_on.iter().collect();
    let outputs = plan
        .tasks
        .iter()
        .filter(|item| {
            item.status == RequirementTaskStatus::Completed && direct_ids.contains(&item.id)
        })
        .map(|item| {
            format!(
                "- {}：{}",
                item.title,
                item.result_summary.as_deref().unwrap_or("已完成")
            )
        })
        .collect::<Vec<_>>();
    if outputs.is_empty() {
        "暂无".to_owned()
    } else {
        outputs.join("\n")
    }
}

fn expand_execution_tasks(
    implementation_tasks: Vec<RequirementExecutionTask>,
) -> Vec<RequirementExecutionTask> {
    let (implementation_tasks, mut branch_merge_tasks) = insert_branch_merges(implementation_tasks);
    let mut final_dependencies =
        final_merge_dependencies(&implementation_tasks, &branch_merge_tasks);
    if final_dependencies.len() > 1 {
        let merge_id = format!("branch-merge-{}", branch_merge_tasks.len() + 1);
        branch_merge_tasks.push(branch_merge_task(
            merge_id.clone(),
            final_dependencies,
            "合并所有末端并行任务分支，交由最终合并审核。".to_owned(),
        ));
        final_dependencies = vec![merge_id];
    }
    let mut tasks = Vec::with_capacity(implementation_tasks.len() * (REVIEW_ANGLES.len() + 2) + 2);
    for task in implementation_tasks {
        tasks.push(task.clone());
        let review_summary_id = format!("review-summary-{}", task.id);
        for (index, angle) in REVIEW_ANGLES.iter().enumerate() {
            tasks.push(RequirementExecutionTask {
                id: format!("review-sub-{}-{}", task.id, index + 1),
                title: format!("审核({angle})：{}", task.title),
                description: format!(
                    "从「{angle}」角度审核实现节点「{}」的提交和 diff。",
                    task.title
                ),
                depends_on: vec![task.id.clone()],
                kind: RequirementTaskKind::ReviewSubAgent,
                model_tier: effective_model_tier(RequirementTaskKind::ReviewSubAgent),
                timeout_seconds: 90,
                pi_session_file: None,
                branch_name: None,
                worktree_path: None,
                review_for: Some(task.id.clone()),
                review_angle: Some((*angle).to_owned()),
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
                pull_request_url: None,
                merged_into: None,
                cleanup_summary: None,
                execution_warning: None,
                trace: None,
                status: RequirementTaskStatus::Pending,
                target_files: task.target_files.clone(),
                result_summary: None,
                error: None,
            });
        }
        tasks.push(RequirementExecutionTask {
            id: review_summary_id.clone(),
            title: format!("审核汇总：{}", task.title),
            description: format!("汇总三个审核 Sub Agent 对「{}」的审核意见。", task.title),
            depends_on: (1..=REVIEW_ANGLES.len())
                .map(|index| format!("review-sub-{}-{}", task.id, index))
                .collect(),
            kind: RequirementTaskKind::ReviewSummary,
            model_tier: effective_model_tier(RequirementTaskKind::ReviewSummary),
            timeout_seconds: 90,
            pi_session_file: None,
            branch_name: None,
            worktree_path: None,
            review_for: Some(task.id.clone()),
            review_angle: Some("审核汇总".to_owned()),
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
            pull_request_url: None,
            merged_into: None,
            cleanup_summary: None,
            execution_warning: None,
            trace: None,
            status: RequirementTaskStatus::Pending,
            target_files: task.target_files.clone(),
            result_summary: None,
            error: None,
        });
    }
    tasks.extend(branch_merge_tasks);
    tasks.push(RequirementExecutionTask {
        id: "merge-review".to_owned(),
        title: "最终合并审核".to_owned(),
        description: "在已汇集所有审核通过实现分支的独立分支上运行最终检查并审核。".to_owned(),
        depends_on: final_dependencies,
        kind: RequirementTaskKind::MergeReview,
        model_tier: RequirementModelTier::High,
        timeout_seconds: 90,
        pi_session_file: None,
        branch_name: None,
        worktree_path: None,
        review_for: None,
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
        pull_request_url: None,
        merged_into: None,
        cleanup_summary: None,
        execution_warning: None,
        trace: None,
        status: RequirementTaskStatus::Pending,
        target_files: Vec::new(),
        result_summary: None,
        error: None,
    });
    tasks
}

fn insert_branch_merges(
    mut implementation_tasks: Vec<RequirementExecutionTask>,
) -> (Vec<RequirementExecutionTask>, Vec<RequirementExecutionTask>) {
    let mut branch_merges = Vec::new();
    let implementation_ids = implementation_tasks
        .iter()
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();
    let dependency_graph = implementation_tasks
        .iter()
        .map(|task| {
            (
                task.id.clone(),
                task.depends_on.iter().cloned().collect::<HashSet<_>>(),
            )
        })
        .collect::<HashMap<_, _>>();

    for task in &mut implementation_tasks {
        let (implementation_dependencies, mut other_dependencies): (Vec<_>, Vec<_>) = task
            .depends_on
            .iter()
            .cloned()
            .partition(|dependency| implementation_ids.contains(dependency));
        other_dependencies.extend(transitive_reduction(
            &implementation_dependencies,
            &dependency_graph,
        ));
        task.depends_on = other_dependencies;
        task.depends_on.sort();
        task.depends_on.dedup();
    }

    for layer in implementation_layers(&implementation_tasks) {
        if layer.len() <= 1 {
            continue;
        }
        let merge_id = format!("branch-merge-{}", branch_merges.len() + 1);
        let layer_set = layer.iter().cloned().collect::<HashSet<_>>();
        let mut used = false;
        for task in &mut implementation_tasks {
            if layer_set.contains(&task.id)
                || !task
                    .depends_on
                    .iter()
                    .any(|dependency| layer_set.contains(dependency))
            {
                continue;
            }
            task.depends_on
                .retain(|dependency| !layer_set.contains(dependency));
            task.depends_on.push(merge_id.clone());
            task.depends_on.sort();
            task.depends_on.dedup();
            used = true;
        }
        if used {
            branch_merges.push(branch_merge_task(
                merge_id,
                layer.clone(),
                format!(
                    "合并 {} 个同阶段并行任务分支，后续任务从合并结果继续。",
                    layer.len()
                ),
            ));
        }
    }

    (implementation_tasks, branch_merges)
}

fn implementation_layers(tasks: &[RequirementExecutionTask]) -> Vec<Vec<String>> {
    let task_ids = tasks
        .iter()
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();
    let mut remaining = task_ids.clone();
    let mut completed = HashSet::new();
    let mut layers = Vec::new();

    while !remaining.is_empty() {
        let mut layer = tasks
            .iter()
            .filter(|task| remaining.contains(&task.id))
            .filter(|task| {
                task.depends_on
                    .iter()
                    .filter(|dependency| task_ids.contains(*dependency))
                    .all(|dependency| completed.contains(dependency))
            })
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        if layer.is_empty() {
            break;
        }
        layer.sort();
        for task_id in &layer {
            remaining.remove(task_id);
            completed.insert(task_id.clone());
        }
        layers.push(layer);
    }

    layers
}

fn branch_merge_task(
    id: String,
    depends_on: Vec<String>,
    description: String,
) -> RequirementExecutionTask {
    RequirementExecutionTask {
        title: format!("分支合并 {}", id.trim_start_matches("branch-merge-")),
        id,
        description,
        depends_on,
        kind: RequirementTaskKind::BranchMerge,
        model_tier: RequirementModelTier::High,
        timeout_seconds: 90,
        pi_session_file: None,
        branch_name: None,
        worktree_path: None,
        review_for: None,
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
        pull_request_url: None,
        merged_into: None,
        cleanup_summary: None,
        execution_warning: None,
        trace: None,
        status: RequirementTaskStatus::Pending,
        target_files: Vec::new(),
        result_summary: None,
        error: None,
    }
}

fn transitive_reduction(
    dependencies: &[String],
    graph: &HashMap<String, HashSet<String>>,
) -> Vec<String> {
    dependencies
        .iter()
        .filter(|dep| {
            !dependencies
                .iter()
                .any(|other| *other != **dep && is_reachable(other, dep, graph))
        })
        .cloned()
        .collect()
}

fn is_reachable(from: &str, to: &str, graph: &HashMap<String, HashSet<String>>) -> bool {
    let mut visited = HashSet::new();
    let mut stack = vec![from.to_owned()];
    while let Some(current) = stack.pop() {
        if current == to {
            return true;
        }
        if !visited.insert(current.clone()) {
            continue;
        }
        if let Some(deps) = graph.get(&current) {
            for dep in deps {
                stack.push(dep.clone());
            }
        }
    }
    false
}

fn final_merge_dependencies(
    implementation_tasks: &[RequirementExecutionTask],
    branch_merge_tasks: &[RequirementExecutionTask],
) -> Vec<String> {
    let mut external_nodes = implementation_tasks
        .iter()
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();
    external_nodes.extend(branch_merge_tasks.iter().map(|task| task.id.clone()));
    let depended_on = implementation_tasks
        .iter()
        .chain(branch_merge_tasks.iter())
        .flat_map(|task| task.depends_on.iter())
        .filter(|dependency| external_nodes.contains(*dependency))
        .cloned()
        .collect::<HashSet<_>>();
    let mut dependencies = external_nodes
        .difference(&depended_on)
        .cloned()
        .collect::<Vec<_>>();
    dependencies.sort();
    dependencies
}

fn review_feedback_for_prompt(plan: &RequirementExecutionPlan, review_for: Option<&str>) -> String {
    let Some(review_for) = review_for else {
        return "暂无审核 Sub Agent 意见。".to_owned();
    };
    let feedback = plan
        .tasks
        .iter()
        .filter(|task| {
            task.kind == RequirementTaskKind::ReviewSubAgent
                && task.review_for.as_deref() == Some(review_for)
        })
        .map(|task| {
            format!(
                "- {}：{}；意见：{}",
                task.review_angle.as_deref().unwrap_or("综合审核"),
                match task.review_status {
                    RequirementReviewStatus::Approved => "通过",
                    RequirementReviewStatus::Rejected => "不通过",
                    RequirementReviewStatus::Pending => "待审核",
                },
                task.last_review_feedback.as_deref().unwrap_or("无")
            )
        })
        .collect::<Vec<_>>();
    if feedback.is_empty() {
        "暂无审核 Sub Agent 意见。".to_owned()
    } else {
        format!("## 审核 Sub Agent 意见\n{}", feedback.join("\n"))
    }
}

fn format_draft(draft: &RequirementDraft) -> String {
    format!(
        "标题：{}\n摘要：{}\n验收标准：\n{}",
        draft.title,
        draft.summary,
        draft
            .acceptance_criteria
            .iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

fn format_requirement_summary_for_task(draft: &RequirementDraft) -> String {
    format!("需求：{}\n说明：{}", draft.title, draft.summary)
}

fn extract_json_object(text: &str) -> Result<Value, AppError> {
    let start = text
        .find('{')
        .ok_or_else(|| AppError::internal("Pi Agent 未返回 JSON 对象"))?;
    let end = text
        .rfind('}')
        .ok_or_else(|| AppError::internal("Pi Agent 未返回完整 JSON 对象"))?;
    serde_json::from_str(&text[start..=end]).map_err(AppError::from)
}

fn normalize_task_id(id: &str, index: usize) -> String {
    let normalized = id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    if normalized.is_empty() {
        format!("task-{}", index + 1)
    } else {
        normalized
    }
}

fn validate_task_graph(tasks: &[RequirementExecutionTask]) -> Result<(), AppError> {
    let ids = tasks
        .iter()
        .map(|task| task.id.as_str())
        .collect::<HashSet<_>>();
    if ids.len() != tasks.len() {
        return Err(AppError::internal("执行计划存在重复任务 id"));
    }

    for task in tasks {
        if task.title.trim().is_empty() || task.description.trim().is_empty() {
            return Err(AppError::internal("执行计划存在空任务标题或描述"));
        }
        for dependency in &task.depends_on {
            if !ids.contains(dependency.as_str()) {
                return Err(AppError::internal("执行计划引用了不存在的前置任务"));
            }
        }
    }
    ensure_acyclic(tasks)?;
    Ok(())
}

fn ensure_acyclic(tasks: &[RequirementExecutionTask]) -> Result<(), AppError> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum VisitState {
        Visiting,
        Visited,
    }

    fn visit(
        task_id: &str,
        task_map: &HashMap<&str, &RequirementExecutionTask>,
        states: &mut HashMap<String, VisitState>,
    ) -> Result<(), AppError> {
        if let Some(state) = states.get(task_id) {
            return if *state == VisitState::Visiting {
                Err(AppError::internal("执行计划依赖形成了环"))
            } else {
                Ok(())
            };
        }

        states.insert(task_id.to_owned(), VisitState::Visiting);
        let task = task_map
            .get(task_id)
            .ok_or_else(|| AppError::internal("执行计划引用了不存在的任务"))?;
        for dependency in &task.depends_on {
            visit(dependency, task_map, states)?;
        }
        states.insert(task_id.to_owned(), VisitState::Visited);
        Ok(())
    }

    let task_map = tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect::<HashMap<_, _>>();
    let mut states = HashMap::new();
    for task in tasks {
        visit(&task.id, &task_map, &mut states)?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct RawPlan {
    summary: String,
    tasks: Vec<RawTask>,
}

#[derive(Debug, Deserialize)]
struct RawTask {
    id: String,
    title: String,
    description: String,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    target_files: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawTaskOutput {
    #[serde(default)]
    result_summary: Option<String>,
    #[serde(default)]
    approved: Option<bool>,
    #[serde(default)]
    feedback: Option<String>,
    #[serde(default)]
    changed: Option<bool>,
    #[serde(default)]
    no_op_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawRecoveryGuidance {
    root_cause: String,
    strategy: String,
    #[serde(default)]
    steps: Vec<String>,
    #[serde(default)]
    verification: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        build_recovery_guidance_json_repair_prompt, build_requirement_plan_prompt,
        build_requirement_task_prompt, build_task_output_json_repair_prompt, effective_model_tier,
        parse_recovery_guidance, parse_requirement_plan, parse_task_execution_output,
    };
    use chrono::Utc;
    use raccoon_core::models::{
        Requirement, RequirementDraft, RequirementExecutionPlan, RequirementExecutionTask,
        RequirementModelTier, RequirementRecoveryStage, RequirementReviewStatus,
        RequirementTaskKind, RequirementTaskStatus,
    };

    #[test]
    fn planning_prompt_forbids_check_only_tasks() {
        let requirement = test_requirement("重命名旧文案");
        let prompt = build_requirement_plan_prompt(&requirement);

        assert!(prompt.contains("tasks 数量 1-10 个"));
        assert!(prompt.contains("禁止生成纯审核、纯校验、纯检查、纯原因分析任务"));
        assert!(
            prompt.contains("check.js、残留字符串检查、代码质量检查只能作为实现任务的验证标准")
        );
        assert!(prompt.contains("简单命名、文案、单点修改优先生成 1 个实现任务"));
        assert!(prompt.contains("target_files 只应列出当前任务会实际修改的文件"));
        assert!(prompt.contains("description 必须自包含"));
        assert!(prompt.contains("即便不参考完整需求，实现者只看描述也能独立完成"));
        assert!(prompt.contains("本任务要修改什么、产出什么"));
        assert!(prompt.contains("明确不做什么"));
        assert!(prompt.contains("禁止在 description 中使用"));
        assert!(prompt.contains("严禁前置任务提前实现后续任务的功能"));
        assert!(prompt.contains("骨架/基础结构任务只能创建空容器、类型定义、路由占位"));
        assert!(prompt.contains("并行阶段之后的任务必须等待该阶段全部任务完成"));
        assert!(prompt.contains("会修改相同文件的任务禁止并行"));
        assert!(prompt.contains("DAG 必须按“阶段”拆分"));
        assert!(prompt.contains("并行组内每个任务的 depends_on 必须完全相同"));
        assert!(prompt.contains("不要在 tasks 中生成合并任务"));
    }

    #[test]
    fn json_repair_prompts_include_error_excerpt_and_contract() {
        let mut task = test_task("review-task-1", "审核实现", Vec::new());
        task.kind = RequirementTaskKind::ReviewSubAgent;
        let prompt = build_task_output_json_repair_prompt(
            &task,
            "expected value at line 1 column 1",
            &"x".repeat(4100),
        );

        assert!(prompt.contains("expected value at line 1 column 1"));
        assert!(prompt.contains("上一轮输出摘录"));
        assert!(prompt.contains("已截断"));
        assert!(prompt.contains("\"approved\": true"));
        assert!(prompt.contains("只输出一个合法 JSON 对象"));

        let guidance_prompt = build_recovery_guidance_json_repair_prompt("missing field", "{} ");
        assert!(guidance_prompt.contains("\"root_cause\""));
        assert!(guidance_prompt.contains("missing field"));
    }

    #[test]
    fn parse_requirement_plan_rejects_duplicate_ids() {
        let error = parse_requirement_plan(
            r#"{
              "summary": "执行计划",
              "tasks": [
                {
                  "id": "Task-1",
                  "title": "任务一",
                  "description": "完成任务一",
                  "depends_on": [],
                  "target_files": []
                },
                {
                  "id": "task-1",
                  "title": "任务二",
                  "description": "完成任务二",
                  "depends_on": [],
                  "target_files": []
                }
              ]
            }"#,
        )
        .unwrap_err();

        assert!(error.to_string().contains("重复任务 id"));
    }

    #[test]
    fn parse_task_execution_output_keeps_no_op_fields() {
        let output = parse_task_execution_output(
            r#"{
              "changed": false,
              "no_op_reason": "前置节点已完整实现，已验证搜索筛选逻辑存在",
              "result_summary": "无需修改"
            }"#,
            None,
        )
        .unwrap();

        assert_eq!(output.changed, Some(false));
        assert_eq!(
            output.no_op_reason.as_deref(),
            Some("前置节点已完整实现，已验证搜索筛选逻辑存在")
        );
    }

    #[test]
    fn task_kinds_use_expected_model_tiers() {
        assert_eq!(
            effective_model_tier(RequirementTaskKind::Implementation),
            RequirementModelTier::Low
        );
        assert_eq!(
            effective_model_tier(RequirementTaskKind::ReviewSummary),
            RequirementModelTier::Low
        );
        assert_eq!(
            effective_model_tier(RequirementTaskKind::ReviewSubAgent),
            RequirementModelTier::Medium
        );
        assert_eq!(
            effective_model_tier(RequirementTaskKind::MergeReview),
            RequirementModelTier::High
        );
    }

    #[test]
    fn recovery_guidance_is_normalized_for_task_prompt() {
        let guidance = parse_recovery_guidance(
            r#"{
              "root_cause": "边界条件遗漏",
              "strategy": "补齐校验",
              "steps": ["修改校验", "补测试"],
              "verification": ["运行 npm run check"]
            }"#,
        )
        .unwrap();

        assert!(guidance.contains("根因：边界条件遗漏"));
        assert!(guidance.contains("修改校验；补测试"));
    }

    #[test]
    fn implementation_prompt_contains_hard_boundary_and_no_op_contract() {
        let requirement = test_requirement("实现页面");
        let current = test_task("task-1", "创建骨架", Vec::new());
        let future = test_task("task-2", "实现搜索", vec!["task-1".to_owned()]);
        let plan = RequirementExecutionPlan {
            summary: "计划".to_owned(),
            tasks: vec![current.clone(), future],
        };
        let prompt = build_requirement_task_prompt(&requirement, &plan, &current);

        assert!(prompt.contains("\"changed\": true"));
        assert!(prompt.contains("\"no_op_reason\": null"));
        assert!(prompt.contains("任务边界（必须遵守）"));
        assert!(prompt.contains("禁止实现任何未在本描述中明确列出的功能"));
        assert!(prompt.contains("禁止以“预留”“提前准备”“顺便”等理由实现后续任务的功能"));
        assert!(
            !prompt.contains("实现搜索"),
            "future task titles should not appear"
        );
    }

    #[test]
    fn implementation_prompt_does_not_contain_full_draft() {
        let mut requirement = test_requirement("实现页面");
        if let Some(ref mut draft) = requirement.draft {
            draft.title = "完整需求标题".to_owned();
            draft.summary = "完整需求摘要".to_owned();
            draft.acceptance_criteria = vec!["必须支持 A".to_owned(), "必须支持 B".to_owned()];
        }
        let current = test_task("task-1", "创建骨架", Vec::new());
        let plan = RequirementExecutionPlan {
            summary: "计划".to_owned(),
            tasks: vec![current.clone()],
        };
        let prompt = build_requirement_task_prompt(&requirement, &plan, &current);

        assert!(
            prompt.contains("完整需求标题"),
            "one-line summary title should appear"
        );
        assert!(
            !prompt.contains("验收标准"),
            "full acceptance criteria must not appear"
        );
        assert!(
            !prompt.contains("必须支持 A"),
            "individual acceptance criteria must not appear"
        );
    }

    #[test]
    fn implementation_prompt_shows_only_direct_dependencies() {
        let requirement = test_requirement("实现页面");
        let mut completed_a = test_task("task-a", "任务 A", Vec::new());
        completed_a.status = RequirementTaskStatus::Completed;
        completed_a.result_summary = Some("完成了 A".to_owned());
        let mut completed_b = test_task("task-b", "任务 B", vec!["task-a".to_owned()]);
        completed_b.status = RequirementTaskStatus::Completed;
        completed_b.result_summary = Some("完成了 B".to_owned());
        let current = test_task("task-c", "任务 C", vec!["task-b".to_owned()]);
        let plan = RequirementExecutionPlan {
            summary: "计划".to_owned(),
            tasks: vec![completed_a.clone(), completed_b.clone(), current.clone()],
        };
        let prompt = build_requirement_task_prompt(&requirement, &plan, &current);

        assert!(prompt.contains("任务 B"), "direct dependency must appear");
        assert!(
            !prompt.contains("任务 A"),
            "transitive dependency must not appear"
        );
    }

    #[test]
    fn implementation_prompt_does_not_list_future_task_descriptions() {
        let requirement = test_requirement("实现页面");
        let current = test_task("task-1", "创建骨架", Vec::new());
        let future = test_task("task-2", "实现搜索", vec!["task-1".to_owned()]);
        let plan = RequirementExecutionPlan {
            summary: "计划".to_owned(),
            tasks: vec![current.clone(), future],
        };
        let prompt = build_requirement_task_prompt(&requirement, &plan, &current);

        assert!(
            !prompt.contains("后续未完成实现任务"),
            "future tasks section must be removed"
        );
        assert!(
            !prompt.contains("只做实现搜索"),
            "future task description must not appear"
        );
    }

    #[test]
    fn merge_review_prompt_forbids_publication_commands() {
        let requirement = test_requirement("最终审核");
        let mut task = test_task("merge-review", "最终合并审核", Vec::new());
        task.kind = RequirementTaskKind::MergeReview;
        let plan = RequirementExecutionPlan {
            summary: "计划".to_owned(),
            tasks: vec![task.clone()],
        };

        let prompt = build_requirement_task_prompt(&requirement, &plan, &task);

        assert!(prompt.contains("当前独立工作区已包含所有审核通过的前置分支"));
        assert!(prompt.contains("禁止 checkout、switch、merge、rebase、push 或执行 gh pr"));
        assert!(prompt.contains("最终发布由系统处理"));
    }

    #[test]
    fn fixing_and_review_prompts_pin_latest_feedback_and_commit() {
        let requirement = test_requirement("修复页面");
        let mut implementation = test_task("task-1", "修复实现", Vec::new());
        implementation.status = RequirementTaskStatus::Fixing;
        implementation.last_review_feedback = Some("补充边界校验".to_owned());
        let mut review = test_task("review-task-1", "审核实现", vec!["task-1".to_owned()]);
        review.kind = RequirementTaskKind::ReviewSubAgent;
        review.review_for = Some("task-1".to_owned());
        let plan = RequirementExecutionPlan {
            summary: "计划".to_owned(),
            tasks: vec![implementation.clone(), review.clone()],
        };

        let fixing_prompt = build_requirement_task_prompt(&requirement, &plan, &implementation);
        assert!(fixing_prompt.contains("当前状态：未提交，改动位于暂存区"));
        assert!(fixing_prompt.contains("最新审核反馈：补充边界校验"));
        assert!(fixing_prompt.contains("必须针对审核反馈产生实际代码修改"));

        let review_prompt = build_requirement_task_prompt(&requirement, &plan, &review);
        assert!(review_prompt.contains("只审核 git diff --cached"));
        assert!(review_prompt.contains("不要修改代码"));
    }

    #[test]
    fn review_prompts_are_scoped_to_reviewed_task_not_full_requirement() {
        let mut requirement = test_requirement("全量需求");
        if let Some(ref mut draft) = requirement.draft {
            draft.title = "完整需求标题".to_owned();
            draft.summary = "完整需求摘要：包含 A 和 B 两个子任务".to_owned();
        }
        let implementation = test_task("task-1", "修复道路回收", Vec::new());
        let mut review_sub = test_task(
            "review-sub-task-1-1",
            "审核(正确性)：修复道路回收",
            vec!["task-1".to_owned()],
        );
        review_sub.kind = RequirementTaskKind::ReviewSubAgent;
        review_sub.review_for = Some("task-1".to_owned());
        review_sub.review_angle = Some("正确性".to_owned());
        let mut review = test_task(
            "review-task-1",
            "审核：修复道路回收",
            vec!["task-1".to_owned()],
        );
        review.kind = RequirementTaskKind::Review;
        review.review_for = Some("task-1".to_owned());
        review.review_angle = Some("综合审核".to_owned());
        let mut review_summary = test_task(
            "review-summary-task-1",
            "审核汇总：修复道路回收",
            vec!["review-task-1".to_owned()],
        );
        review_summary.kind = RequirementTaskKind::ReviewSummary;
        review_summary.review_for = Some("task-1".to_owned());
        let plan = RequirementExecutionPlan {
            summary: "计划".to_owned(),
            tasks: vec![
                implementation.clone(),
                review_sub.clone(),
                review.clone(),
                review_summary.clone(),
            ],
        };

        let sub_prompt = build_requirement_task_prompt(&requirement, &plan, &review_sub);
        assert!(sub_prompt.contains("只审核 git diff --cached"));
        assert!(sub_prompt.contains("审核目标：审核(正确性)：修复道路回收"));
        assert!(
            !sub_prompt.contains("完整需求摘要：包含 A 和 B 两个子任务"),
            "ReviewSubAgent prompt must not see the full requirement draft"
        );

        let review_prompt = build_requirement_task_prompt(&requirement, &plan, &review);
        assert!(review_prompt.contains("本次审核范围见下方「当前任务」"));
        assert!(review_prompt.contains("当前任务"));
        assert!(review_prompt.contains("修复道路回收"));
        assert!(
            !review_prompt.contains("完整需求摘要：包含 A 和 B 两个子任务"),
            "Review prompt must not see the full requirement draft"
        );

        let summary_prompt = build_requirement_task_prompt(&requirement, &plan, &review_summary);
        assert!(summary_prompt.contains("本次审核范围见下方「当前任务」"));
        assert!(summary_prompt.contains("当前任务"));
        assert!(summary_prompt.contains("修复道路回收"));
        assert!(
            !summary_prompt.contains("完整需求摘要：包含 A 和 B 两个子任务"),
            "ReviewSummary prompt must not see the full requirement draft"
        );
    }

    fn test_requirement(title: &str) -> Requirement {
        Requirement {
            id: "req-1".to_owned(),
            project_id: "project-1".to_owned(),
            title: title.to_owned(),
            original_message: title.to_owned(),
            status: raccoon_core::models::RequirementStatus::Running,
            messages: Vec::new(),
            clarification_round: 0,
            clarifications: Vec::new(),
            draft: Some(RequirementDraft {
                title: title.to_owned(),
                summary: title.to_owned(),
                acceptance_criteria: vec!["可以打开".to_owned()],
            }),
            analysis_revision: 0,
            active_prompt: None,
            clarification_history: Vec::new(),
            execution_plan: None,
            pi_session_file: None,
            error: None,
            queued_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn test_task(id: &str, title: &str, depends_on: Vec<String>) -> RequirementExecutionTask {
        RequirementExecutionTask {
            id: id.to_owned(),
            title: title.to_owned(),
            description: format!("只做{title}；不做后续任务；运行检查验证。"),
            depends_on,
            kind: RequirementTaskKind::Implementation,
            model_tier: RequirementModelTier::Medium,
            timeout_seconds: 90,
            pi_session_file: None,
            branch_name: None,
            worktree_path: None,
            review_for: None,
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
            pull_request_url: None,
            merged_into: None,
            cleanup_summary: None,
            execution_warning: None,
            trace: None,
            status: RequirementTaskStatus::Pending,
            target_files: vec!["index.html".to_owned()],
            result_summary: None,
            error: None,
        }
    }

    #[test]
    fn parse_requirement_plan_rejects_cycles() {
        let error = parse_requirement_plan(
            r#"{
              "summary": "执行计划",
              "tasks": [
                {
                  "id": "task-a",
                  "title": "任务 A",
                  "description": "完成任务 A",
                  "depends_on": ["task-b"],
                  "target_files": []
                },
                {
                  "id": "task-b",
                  "title": "任务 B",
                  "description": "完成任务 B",
                  "depends_on": ["task-a"],
                  "target_files": []
                }
              ]
            }"#,
        )
        .unwrap_err();

        assert!(error.to_string().contains("形成了环"));
    }

    #[test]
    fn parse_requirement_plan_keeps_review_group_for_single_task() {
        let plan = parse_requirement_plan(
            r#"{
              "summary": "执行计划",
              "tasks": [
                {
                  "id": "task-a",
                  "title": "修改命名",
                  "description": "完成命名修改，并运行 check.js 验证无旧字符串残留。",
                  "depends_on": [],
                  "target_files": []
                }
              ]
            }"#,
        )
        .unwrap();

        assert_eq!(
            plan.tasks
                .iter()
                .filter(|task| task.kind == RequirementTaskKind::ReviewSubAgent)
                .count(),
            3
        );
        assert!(plan.tasks.iter().any(|task| {
            task.kind == RequirementTaskKind::ReviewSummary
                && task.review_for.as_deref() == Some("task-a")
        }));
        assert!(
            plan.tasks
                .iter()
                .any(|task| task.kind == RequirementTaskKind::MergeReview)
        );

        let merge_review = plan
            .tasks
            .iter()
            .find(|task| task.kind == RequirementTaskKind::MergeReview)
            .unwrap();
        assert_eq!(merge_review.depends_on, vec!["task-a"]);
    }

    #[test]
    fn parse_requirement_plan_expands_review_group() {
        let plan = parse_requirement_plan(
            r#"{
              "summary": "执行计划",
              "tasks": [
                {
                  "id": "task-a",
                  "title": "任务 A",
                  "description": "完成任务 A",
                  "depends_on": [],
                  "target_files": [],
                  "review_angles": ["代码质量", "测试覆盖"]
                },
                {
                  "id": "task-b",
                  "title": "任务 B",
                  "description": "完成任务 B",
                  "depends_on": ["task-a"],
                  "target_files": []
                }
              ]
            }"#,
        )
        .unwrap();

        let task_a_reviews = plan
            .tasks
            .iter()
            .filter(|task| task.kind == RequirementTaskKind::ReviewSubAgent)
            .filter(|task| task.review_for.as_deref() == Some("task-a"))
            .collect::<Vec<_>>();
        assert_eq!(task_a_reviews.len(), 3);
        assert_eq!(task_a_reviews[0].review_angle.as_deref(), Some("正确性"));
        assert_eq!(
            task_a_reviews[1].review_angle.as_deref(),
            Some("边界与安全")
        );
        assert_eq!(
            task_a_reviews[2].review_angle.as_deref(),
            Some("代码质量与测试")
        );

        let task_b_summary = plan
            .tasks
            .iter()
            .find(|task| {
                task.kind == RequirementTaskKind::ReviewSummary
                    && task.review_for.as_deref() == Some("task-b")
            })
            .unwrap();
        assert_eq!(task_b_summary.review_angle.as_deref(), Some("审核汇总"));
    }

    #[test]
    fn parse_requirement_plan_adds_barriers_between_parallel_stages() {
        let plan = parse_requirement_plan(
            r#"{
              "summary": "执行计划",
              "tasks": [
                {
                  "id": "task-a",
                  "title": "任务 A",
                  "description": "完成任务 A",
                  "depends_on": [],
                  "target_files": []
                },
                {
                  "id": "task-b",
                  "title": "任务 B",
                  "description": "完成任务 B",
                  "depends_on": [],
                  "target_files": []
                },
                {
                  "id": "task-c",
                  "title": "任务 C",
                  "description": "完成任务 C",
                  "depends_on": ["task-b"],
                  "target_files": []
                },
                {
                  "id": "task-d",
                  "title": "任务 D",
                  "description": "完成任务 D",
                  "depends_on": ["task-b"],
                  "target_files": []
                },
                {
                  "id": "task-e",
                  "title": "任务 E",
                  "description": "完成任务 E",
                  "depends_on": ["task-b"],
                  "target_files": []
                },
                {
                  "id": "task-f",
                  "title": "任务 F",
                  "description": "完成任务 F",
                  "depends_on": ["task-b"],
                  "target_files": []
                },
                {
                  "id": "task-g",
                  "title": "任务 G",
                  "description": "完成任务 G",
                  "depends_on": ["task-c", "task-d", "task-e", "task-f"],
                  "target_files": []
                }
              ]
            }"#,
        )
        .unwrap();

        let first_merge = plan
            .tasks
            .iter()
            .find(|task| task.id == "branch-merge-1")
            .unwrap();
        assert_eq!(first_merge.depends_on, vec!["task-a", "task-b"]);

        for task_id in ["task-c", "task-d", "task-e", "task-f"] {
            let task = plan.tasks.iter().find(|task| task.id == task_id).unwrap();
            assert_eq!(task.depends_on, vec!["branch-merge-1"]);
        }

        let second_merge = plan
            .tasks
            .iter()
            .find(|task| task.id == "branch-merge-2")
            .unwrap();
        assert_eq!(
            second_merge.depends_on,
            vec!["task-c", "task-d", "task-e", "task-f"]
        );

        let task_g = plan.tasks.iter().find(|task| task.id == "task-g").unwrap();
        assert_eq!(task_g.depends_on, vec!["branch-merge-2"]);
    }

    #[test]
    fn parse_requirement_plan_removes_redundant_branch_merge_for_serial_chain() {
        let plan = parse_requirement_plan(
            r#"{
              "summary": "执行计划",
              "tasks": [
                {
                  "id": "task-1",
                  "title": "任务一",
                  "description": "完成任务一",
                  "depends_on": [],
                  "target_files": []
                },
                {
                  "id": "task-2",
                  "title": "任务二",
                  "description": "完成任务二",
                  "depends_on": ["task-1"],
                  "target_files": []
                },
                {
                  "id": "task-3",
                  "title": "任务三",
                  "description": "完成任务三",
                  "depends_on": ["task-1", "task-2"],
                  "target_files": []
                }
              ]
            }"#,
        )
        .unwrap();

        assert!(
            !plan
                .tasks
                .iter()
                .any(|task| task.kind == RequirementTaskKind::BranchMerge)
        );

        let task_3 = plan.tasks.iter().find(|task| task.id == "task-3").unwrap();
        assert_eq!(task_3.depends_on, vec!["task-2"]);

        let merge_review = plan
            .tasks
            .iter()
            .find(|task| task.kind == RequirementTaskKind::MergeReview)
            .unwrap();
        assert_eq!(merge_review.depends_on, vec!["task-3"]);
    }

    #[test]
    fn parse_requirement_plan_blocks_parallel_member_from_starting_serial_chain() {
        let plan = parse_requirement_plan(
            r#"{
              "summary": "执行计划",
              "tasks": [
                {
                  "id": "task-1",
                  "title": "独立任务一",
                  "description": "完成独立任务一",
                  "depends_on": [],
                  "target_files": []
                },
                {
                  "id": "task-2",
                  "title": "独立任务二",
                  "description": "完成独立任务二",
                  "depends_on": [],
                  "target_files": []
                },
                {
                  "id": "task-3",
                  "title": "后续任务一",
                  "description": "完成后续任务一",
                  "depends_on": ["task-2"],
                  "target_files": []
                },
                {
                  "id": "task-4",
                  "title": "后续任务二",
                  "description": "完成后续任务二",
                  "depends_on": ["task-3"],
                  "target_files": []
                }
              ]
            }"#,
        )
        .unwrap();

        let merge = plan
            .tasks
            .iter()
            .find(|task| task.kind == RequirementTaskKind::BranchMerge)
            .unwrap();
        assert_eq!(merge.depends_on, vec!["task-1", "task-2"]);

        let task_3 = plan.tasks.iter().find(|task| task.id == "task-3").unwrap();
        assert_eq!(task_3.depends_on, vec![merge.id.clone()]);

        let merge_review = plan
            .tasks
            .iter()
            .find(|task| task.kind == RequirementTaskKind::MergeReview)
            .unwrap();
        assert_eq!(merge_review.depends_on, vec!["task-4"]);
    }

    #[test]
    fn parse_task_execution_output_falls_back_to_no_op_reason_when_summary_missing() {
        let output = parse_task_execution_output(
            r#"{
              "changed": false,
              "no_op_reason": "前置节点已完整实现"
            }"#,
            None,
        )
        .unwrap();

        assert_eq!(output.changed, Some(false));
        assert_eq!(output.result_summary, "前置节点已完整实现");
        assert_eq!(output.no_op_reason.as_deref(), Some("前置节点已完整实现"));
    }
}
