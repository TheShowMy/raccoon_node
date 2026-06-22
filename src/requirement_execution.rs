use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use crate::error::AppError;
use crate::models::{
    Requirement, RequirementDraft, RequirementExecutionPlan, RequirementExecutionTask,
    RequirementModelTier, RequirementReviewStatus, RequirementTaskExecutionOutput,
    RequirementTaskKind, RequirementTaskStatus,
};

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
      "target_files": ["可能涉及的文件或目录"],
      "review_angles": ["审核角度，1-3 个"]
    }}
  ]
}}

要求：
- tasks 数量 2-8 个。
- id 必须稳定、唯一，只能使用小写字母、数字、短横线和下划线。
- depends_on 只能引用已有任务 id，不能形成环。
- 每个任务必须是写代码实现任务，审核和最终合并审核由系统自动补齐。
- target_files 不确定时可以使用目录级路径或空数组。
- review_angles 按任务复杂度给 1-3 个，简单任务 1 个，复杂任务最多 3 个。

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
            review_angles: normalize_review_angles(task.review_angles),
            task: RequirementExecutionTask {
                id: normalize_task_id(&task.id, index),
                title: task.title.trim().to_owned(),
                description: task.description.trim().to_owned(),
                depends_on: task.depends_on,
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
                last_review_feedback: None,
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

    let (role, json_contract, extra) = match task.kind {
        RequirementTaskKind::Implementation => (
            "实现 Agent",
            r#"{
  "result_summary": "本任务完成了什么，涉及哪些关键文件，如何验证"
}"#,
            if task.status == RequirementTaskStatus::Fixing {
                format!(
                    "\n## 审核反馈\n{}\n\n请在原实现基础上修复问题，不要重做无关内容。",
                    task.last_review_feedback.as_deref().unwrap_or("审核未通过")
                )
            } else {
                String::new()
            },
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

pub fn parse_task_execution_output(
    text: &str,
    trace: Option<Value>,
) -> Result<RequirementTaskExecutionOutput, AppError> {
    let value = extract_json_object(text)?;
    let raw: RawTaskOutput = serde_json::from_value(value)?;
    let result_summary = raw.result_summary.trim().to_owned();
    if result_summary.is_empty() {
        return Err(AppError::internal("任务执行结果摘要为空"));
    }
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
        trace,
    })
}

fn expand_execution_tasks(
    implementation_tasks: Vec<PlannedImplementationTask>,
) -> Vec<RequirementExecutionTask> {
    let implementation_ids = implementation_tasks
        .iter()
        .map(|item| item.task.id.clone())
        .collect::<Vec<_>>();
    let mut tasks = Vec::with_capacity(implementation_tasks.len() * 4 + 1);
    for item in implementation_tasks {
        let task = item.task;
        tasks.push(task.clone());
        for (index, angle) in item.review_angles.into_iter().enumerate() {
            tasks.push(RequirementExecutionTask {
                id: format!("review-{}-{}", task.id, index + 1),
                title: format!("审核({angle})：{}", task.title),
                description: format!(
                    "从「{angle}」角度审核实现节点「{}」的提交和 diff。",
                    task.title
                ),
                depends_on: vec![task.id.clone()],
                kind: RequirementTaskKind::Review,
                model_tier: RequirementModelTier::High,
                timeout_seconds: 20 * 60,
                pi_session_file: None,
                branch_name: None,
                worktree_path: None,
                commit_sha: None,
                review_for: Some(task.id.clone()),
                review_angle: Some(angle),
                review_status: RequirementReviewStatus::Pending,
                attempt: 0,
                last_review_feedback: None,
                status: RequirementTaskStatus::Pending,
                target_files: task.target_files.clone(),
                result_summary: None,
                error: None,
            });
        }
    }
    tasks.push(RequirementExecutionTask {
        id: "merge-review".to_owned(),
        title: "最终合并审核".to_owned(),
        description: "合并所有审核通过的实现分支，运行最终检查并做最终审核。".to_owned(),
        depends_on: implementation_ids,
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
        last_review_feedback: None,
        status: RequirementTaskStatus::Pending,
        target_files: Vec::new(),
        result_summary: None,
        error: None,
    });
    tasks
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
    #[serde(default)]
    review_angles: Vec<String>,
}

struct PlannedImplementationTask {
    task: RequirementExecutionTask,
    review_angles: Vec<String>,
}

fn normalize_review_angles(angles: Vec<String>) -> Vec<String> {
    let normalized = angles
        .into_iter()
        .map(|angle| angle.trim().to_owned())
        .filter(|angle| !angle.is_empty())
        .take(3)
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        vec!["综合审核".to_owned()]
    } else {
        normalized
    }
}

#[derive(Debug, Deserialize)]
struct RawTaskOutput {
    result_summary: String,
    #[serde(default)]
    approved: Option<bool>,
    #[serde(default)]
    feedback: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::parse_requirement_plan;
    use crate::models::RequirementTaskKind;

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
    fn parse_requirement_plan_expands_review_angles() {
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
            .filter(|task| task.kind == RequirementTaskKind::Review)
            .filter(|task| task.review_for.as_deref() == Some("task-a"))
            .collect::<Vec<_>>();
        assert_eq!(task_a_reviews.len(), 2);
        assert_eq!(task_a_reviews[0].review_angle.as_deref(), Some("代码质量"));
        assert_eq!(task_a_reviews[1].review_angle.as_deref(), Some("测试覆盖"));

        let task_b_review = plan
            .tasks
            .iter()
            .find(|task| {
                task.kind == RequirementTaskKind::Review
                    && task.review_for.as_deref() == Some("task-b")
            })
            .unwrap();
        assert_eq!(task_b_review.review_angle.as_deref(), Some("综合审核"));
    }
}
