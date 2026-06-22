use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use crate::error::AppError;
use crate::models::{
    Requirement, RequirementDraft, RequirementExecutionPlan, RequirementExecutionTask,
    RequirementTaskExecutionOutput, RequirementTaskStatus,
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
      "target_files": ["可能涉及的文件或目录"]
    }}
  ]
}}

要求：
- tasks 数量 2-8 个。
- id 必须稳定、唯一，只能使用小写字母、数字、短横线和下划线。
- depends_on 只能引用已有任务 id，不能形成环。
- 每个任务必须能由 Pi Agent 在当前仓库内独立执行。
- target_files 不确定时可以使用目录级路径或空数组。

## 确认需求草案
{draft}
"#
    )
}

pub fn parse_requirement_plan(text: &str) -> Result<RequirementExecutionPlan, AppError> {
    let value = extract_json_object(text)?;
    let raw: RawPlan = serde_json::from_value(value)?;
    let tasks = raw
        .tasks
        .into_iter()
        .enumerate()
        .map(|(index, task)| RequirementExecutionTask {
            id: normalize_task_id(&task.id, index),
            title: task.title.trim().to_owned(),
            description: task.description.trim().to_owned(),
            depends_on: task.depends_on,
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
    if tasks.is_empty() {
        return Err(AppError::internal("执行计划没有任务"));
    }
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

    format!(
        r#"你是当前项目的实现 Agent。

Pi Agent 当前工作目录已经是项目仓库根目录。请只执行当前任务，允许修改仓库代码。
必须遵守项目现有技术栈、目录约束和代码风格。
完成后必须只输出一个 JSON 对象，不要 Markdown，不要代码块。

JSON 格式：
{{
  "result_summary": "本任务完成了什么，涉及哪些关键文件，如何验证"
}}

## 确认需求草案
{draft}

## 已完成前置任务
{completed}

## 当前任务
- id：{task_id}
- 标题：{task_title}
- 描述：{task_description}
- 目标文件：{target_files}
"#,
        task_id = task.id,
        task_title = task.title,
        task_description = task.description,
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
        trace,
    })
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

#[derive(Debug, Deserialize)]
struct RawTaskOutput {
    result_summary: String,
}

#[cfg(test)]
mod tests {
    use super::parse_requirement_plan;

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
}
