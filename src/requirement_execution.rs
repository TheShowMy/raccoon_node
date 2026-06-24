use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use crate::error::AppError;
use crate::models::{
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
        RequirementTaskKind::Review | RequirementTaskKind::ReviewSubAgent => {
            RequirementModelTier::Medium
        }
        RequirementTaskKind::BranchMerge | RequirementTaskKind::MergeReview => {
            RequirementModelTier::High
        }
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
- tasks 数量 1-8 个。
- id 必须稳定、唯一，只能使用小写字母、数字、短横线和下划线。
- depends_on 只能引用已有任务 id，不能形成环。
- 每个任务必须是写代码实现任务，审核、分支合并和最终合并审核由系统自动补齐。
- 禁止生成纯审核、纯校验、纯检查、纯原因分析任务。
- check.js、残留字符串检查、代码质量检查只能作为实现任务的验证标准，不能单独成任务。
- 简单命名、文案、单点修改优先生成 1 个实现任务。
- target_files 不确定时可以使用目录级路径或空数组。
- target_files 只应列出当前任务会实际修改的文件，不要把仅用于读取或校验的文件列入。
- 每个任务必须能产生独立、可审查的 diff；如果两个功能天然必须一起实现，就合并成一个任务，不要硬拆。
- description 必须明确写出：本任务只做什么、明确不做什么、完成后如何验证。
- description 不要重复前置任务已经保证的验收标准，只需明确当前任务边界和验证方式。
- 骨架/基础结构任务只能创建必要容器和占位，不得提前实现后续任务中的搜索、复制、语法高亮、数据填充、业务逻辑等功能。
- 后续任务的功能不得被前置任务提前实现；如果某功能已包含在前置任务中，就不要再拆成后续实现任务。

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
        .map(|(index, task)| PlannedImplementationTask {
            task: RequirementExecutionTask {
                id: normalize_task_id(&task.id, index),
                title: task.title.trim().to_owned(),
                description: task.description.trim().to_owned(),
                depends_on: task.depends_on,
                kind: RequirementTaskKind::Implementation,
                model_tier: effective_model_tier(RequirementTaskKind::Implementation),
                timeout_seconds: 45 * 60,
                pi_session_file: None,
                branch_name: None,
                worktree_path: None,
                commit_sha: None,
                review_for: None,
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
                status: RequirementTaskStatus::Pending,
                target_files: task.target_files,
                result_summary: None,
                error: None,
            },
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

pub fn build_requirement_task_prompt(
    requirement: &Requirement,
    plan: &RequirementExecutionPlan,
    task: &RequirementExecutionTask,
) -> String {
    let draft = requirement
        .draft
        .as_ref()
        .map(format_draft)
        .unwrap_or_else(|| "当前需求没有确认草案。".to_owned());
    let completed = plan
        .tasks
        .iter()
        .filter(|item| item.status == RequirementTaskStatus::Completed)
        .map(|item| {
            format!(
                "- {}：{}",
                item.title,
                item.result_summary.as_deref().unwrap_or("已完成")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let future_tasks = future_implementation_tasks_for_prompt(plan, task);
    let failure_context = execution_failure_context(task);

    let (role, json_contract, extra) = match task.kind {
        RequirementTaskKind::Implementation => (
            "实现 Agent",
            r#"{
  "changed": true,
  "no_op_reason": null,
  "result_summary": "本任务完成了什么，涉及哪些关键文件，如何验证"
}"#,
            format!(
                r#"## 严格任务边界
- 只允许实现“当前任务”描述中明确要求的内容。
- 只能修改目标文件范围：{target_files_for_boundary}。
- 禁止提前实现、补全或顺手优化后续未完成任务。
- 当前任务必须自己完成描述中的改名/文案/代码修改，并运行或说明对应检查；不要把验证工作推给后续独立任务。
- 如果发现当前任务能力已经由前置节点完整实现，请不要为了制造 diff 而改文件；必须返回 changed=false，并在 no_op_reason 写清验证依据。
- 如果需要修改文件，changed 必须为 true，no_op_reason 必须为 null。

## 后续未完成实现任务（禁止提前实现）
{future_tasks}
{fix_feedback}
{recovery_guidance}"#,
                target_files_for_boundary = if task.target_files.is_empty() {
                    "未限定，但仍不得修改与当前任务无关的文件".to_owned()
                } else {
                    task.target_files.join("、")
                },
                future_tasks = future_tasks,
                fix_feedback = if task.status == RequirementTaskStatus::Fixing {
                    format!(
                        "\n## 审核反馈\n{}\n\n请在原实现基础上修复问题，不要重做无关内容。",
                        task.last_review_feedback.as_deref().unwrap_or("审核未通过")
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
            r#"{
  "approved": true,
  "feedback": "审核意见，若不通过必须说明需要如何修复",
  "result_summary": "本次审核结论"
}"#,
            format!(
                "请只审核 review_for 对应实现节点的提交和 diff，不要修改代码。\n审核角度：{}",
                task.review_angle.as_deref().unwrap_or("综合审核")
            ),
        ),
        RequirementTaskKind::ReviewSubAgent => (
            "代码审核 Sub Agent",
            r#"{
  "approved": true,
  "feedback": "审核意见，若不通过必须说明需要如何修复",
  "result_summary": "本次审核结论"
}"#,
            format!(
                "请只审核 review_for 对应代码节点的提交和 diff，不要修改代码。\n审核角度：{}",
                task.review_angle.as_deref().unwrap_or("综合审核")
            ),
        ),
        RequirementTaskKind::ReviewSummary => (
            "代码审核汇总 Agent",
            r#"{
  "approved": true,
  "feedback": "汇总后的审核意见，若不通过必须说明代码节点需要如何修复",
  "result_summary": "审核汇总结论"
}"#,
            format!(
                "请汇总三个审核 Sub Agent 的意见，决定 review_for 对应代码节点是否通过。\n{}",
                review_feedback_for_prompt(plan, task.review_for.as_deref())
            ),
        ),
        RequirementTaskKind::BranchMerge => (
            "分支合并 Agent",
            r#"{
  "result_summary": "本分支合并节点完成了什么，是否处理了冲突，如何验证"
}"#,
            "请合并所有前置分支提交；如有冲突，只做最小必要修复。".to_owned(),
        ),
        RequirementTaskKind::MergeReview => (
            "最终合并审核 Agent",
            r#"{
  "approved": true,
  "feedback": "最终审核意见",
  "result_summary": "最终合并审核结论"
}"#,
            "请完成最终合并后的检查，至少运行 npm run check；必要时可以做最小修复。".to_owned(),
        ),
    };

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
- id：{task_id}
- 标题：{task_title}
- 描述：{task_description}
- 目标文件：{target_files}
- 节点类型：{task_kind:?}
- 审核目标：{review_for}
- 审核角度：{review_angle}
{extra}
{failure_context}
"#,
        role = role,
        json_contract = json_contract,
        task_id = task.id,
        task_title = task.title,
        task_description = task.description,
        task_kind = task.kind,
        review_for = task.review_for.as_deref().unwrap_or("无"),
        review_angle = task.review_angle.as_deref().unwrap_or("无"),
        extra = extra,
        failure_context = failure_context,
        target_files = if task.target_files.is_empty() {
            "未限定".to_owned()
        } else {
            task.target_files.join("、")
        },
        completed = if completed.is_empty() {
            "暂无".to_owned()
        } else {
            completed
        }
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
{{
  "root_cause": "根因判断",
  "strategy": "处理策略",
  "steps": ["执行步骤"],
  "verification": ["验证步骤"]
}}

任务：{}
描述：{}
目标文件：{}
失败原因：{}
失败摘要：{}
审核反馈：{}
"#,
        task.title,
        task.description,
        if task.target_files.is_empty() {
            "未限定".to_owned()
        } else {
            task.target_files.join("、")
        },
        task.error.as_deref().unwrap_or("无"),
        task.failure_summary.as_deref().unwrap_or("无"),
        task.last_review_feedback.as_deref().unwrap_or("无"),
    )
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
        commit_sha: None,
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

fn future_implementation_tasks_for_prompt(
    plan: &RequirementExecutionPlan,
    current: &RequirementExecutionTask,
) -> String {
    let future_tasks = plan
        .tasks
        .iter()
        .filter(|task| {
            task.kind == RequirementTaskKind::Implementation
                && task.id != current.id
                && matches!(
                    task.status,
                    RequirementTaskStatus::Pending | RequirementTaskStatus::Fixing
                )
        })
        .map(|task| format!("- {}：{}", task.title, task.description))
        .collect::<Vec<_>>();
    if future_tasks.is_empty() {
        "无".to_owned()
    } else {
        future_tasks.join("\n")
    }
}

fn expand_execution_tasks(
    implementation_tasks: Vec<PlannedImplementationTask>,
) -> Vec<RequirementExecutionTask> {
    let (implementation_tasks, branch_merge_tasks) = insert_branch_merges(
        implementation_tasks
            .into_iter()
            .map(|item| item.task)
            .collect(),
    );
    let final_dependencies = final_merge_dependencies(&implementation_tasks, &branch_merge_tasks);
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
                timeout_seconds: 20 * 60,
                pi_session_file: None,
                branch_name: None,
                worktree_path: None,
                commit_sha: None,
                review_for: Some(task.id.clone()),
                review_angle: Some((*angle).to_owned()),
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
            timeout_seconds: 20 * 60,
            pi_session_file: None,
            branch_name: None,
            worktree_path: None,
            commit_sha: None,
            review_for: Some(task.id.clone()),
            review_angle: Some("审核汇总".to_owned()),
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
        description: "合并所有审核通过的实现分支，运行最终检查并做最终审核。".to_owned(),
        depends_on: final_dependencies,
        kind: RequirementTaskKind::MergeReview,
        model_tier: RequirementModelTier::High,
        timeout_seconds: 45 * 60,
        pi_session_file: None,
        branch_name: None,
        worktree_path: None,
        commit_sha: None,
        review_for: None,
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
    let mut merge_by_dependencies = HashMap::<Vec<String>, String>::new();
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
        let (implementation_dependencies, other_dependencies): (Vec<_>, Vec<_>) = task
            .depends_on
            .iter()
            .cloned()
            .partition(|dependency| implementation_ids.contains(dependency));

        let mut merged_dependencies =
            transitive_reduction(&implementation_dependencies, &dependency_graph);
        merged_dependencies.sort();
        merged_dependencies.dedup();

        task.depends_on = other_dependencies;
        if merged_dependencies.len() <= 1 {
            task.depends_on.extend(merged_dependencies);
            task.depends_on.sort();
            continue;
        }

        let merge_id = if let Some(merge_id) = merge_by_dependencies.get(&merged_dependencies) {
            merge_id.clone()
        } else {
            let merge_id = format!("branch-merge-{}", branch_merges.len() + 1);
            merge_by_dependencies.insert(merged_dependencies.clone(), merge_id.clone());
            branch_merges.push(RequirementExecutionTask {
                id: merge_id.clone(),
                title: format!("分支合并 {}", branch_merges.len() + 1),
                description: format!(
                    "合并 {} 个前置任务分支，作为后续任务主分支继续。",
                    merged_dependencies.len()
                ),
                depends_on: merged_dependencies.clone(),
                kind: RequirementTaskKind::BranchMerge,
                model_tier: RequirementModelTier::High,
                timeout_seconds: 30 * 60,
                pi_session_file: None,
                branch_name: None,
                worktree_path: None,
                commit_sha: None,
                review_for: None,
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
                status: RequirementTaskStatus::Pending,
                target_files: Vec::new(),
                result_summary: None,
                error: None,
            });
            merge_id
        };

        task.depends_on.push(merge_id);
        task.depends_on.sort();
    }

    (implementation_tasks, branch_merges)
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

struct PlannedImplementationTask {
    task: RequirementExecutionTask,
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
        build_requirement_plan_prompt, build_requirement_task_prompt, effective_model_tier,
        parse_recovery_guidance, parse_requirement_plan, parse_task_execution_output,
    };
    use crate::models::{
        Requirement, RequirementDraft, RequirementExecutionPlan, RequirementExecutionTask,
        RequirementModelTier, RequirementRecoveryStage, RequirementReviewStatus,
        RequirementTaskKind, RequirementTaskStatus,
    };
    use chrono::Utc;

    #[test]
    fn planning_prompt_forbids_check_only_tasks() {
        let requirement = test_requirement("重命名旧文案");
        let prompt = build_requirement_plan_prompt(&requirement);

        assert!(prompt.contains("tasks 数量 1-8 个"));
        assert!(prompt.contains("禁止生成纯审核、纯校验、纯检查、纯原因分析任务"));
        assert!(prompt.contains("check.js、残留字符串检查、代码质量检查只能作为实现任务的验证标准"));
        assert!(prompt.contains("简单命名、文案、单点修改优先生成 1 个实现任务"));
        assert!(prompt.contains("target_files 只应列出当前任务会实际修改的文件"));
        assert!(prompt.contains("description 不要重复前置任务已经保证的验收标准"));
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
        assert!(prompt.contains("严格任务边界"));
        assert!(prompt.contains("禁止提前实现、补全或顺手优化后续未完成任务"));
        assert!(prompt.contains("不要把验证工作推给后续独立任务"));
        assert!(prompt.contains("实现搜索"));
    }

    fn test_requirement(title: &str) -> Requirement {
        Requirement {
            id: "req-1".to_owned(),
            project_id: "project-1".to_owned(),
            title: title.to_owned(),
            original_message: title.to_owned(),
            status: crate::models::RequirementStatus::Running,
            messages: Vec::new(),
            clarification_round: 0,
            clarifications: Vec::new(),
            draft: Some(RequirementDraft {
                title: title.to_owned(),
                summary: title.to_owned(),
                acceptance_criteria: vec!["可以打开".to_owned()],
            }),
            execution_plan: None,
            pi_session_file: None,
            error: None,
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
            timeout_seconds: 45 * 60,
            pi_session_file: None,
            branch_name: None,
            worktree_path: None,
            commit_sha: None,
            review_for: None,
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
        assert!(plan
            .tasks
            .iter()
            .any(|task| task.kind == RequirementTaskKind::MergeReview));

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
    fn parse_requirement_plan_inserts_branch_merge_only_for_fan_in() {
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

        assert!(plan
            .tasks
            .iter()
            .filter(|task| task.kind == RequirementTaskKind::BranchMerge)
            .all(|task| task.depends_on != vec!["task-a", "task-b"]));

        for task_id in ["task-c", "task-d", "task-e", "task-f"] {
            let task = plan.tasks.iter().find(|task| task.id == task_id).unwrap();
            assert_eq!(task.depends_on, vec!["task-b"]);
        }

        let merge = plan
            .tasks
            .iter()
            .find(|task| task.id == "branch-merge-1")
            .unwrap();
        assert_eq!(merge.kind, RequirementTaskKind::BranchMerge);
        assert_eq!(
            merge.depends_on,
            vec!["task-c", "task-d", "task-e", "task-f"]
        );

        let task_g = plan.tasks.iter().find(|task| task.id == "task-g").unwrap();
        assert_eq!(task_g.depends_on, vec!["branch-merge-1"]);
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

        assert!(!plan
            .tasks
            .iter()
            .any(|task| task.kind == RequirementTaskKind::BranchMerge));

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
