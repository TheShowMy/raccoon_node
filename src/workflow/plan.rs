use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::models::{AcceptanceScenario, ChangeSpec, Requirement, RequirementMessageRole};

use super::{
    DesignNote, WorkItem, WorkItemDependency, WorkItemStatus, WorkflowRun, WorkflowRunStatus,
    new_workflow_id,
};

const MAX_WORK_ITEMS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkPlan {
    pub summary: String,
    #[serde(default)]
    pub design_notes: Vec<DesignNote>,
    pub work_items: Vec<PlannedWorkItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannedWorkItem {
    pub id: String,
    pub objective: String,
    pub scenario_refs: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub scope_hints: Vec<String>,
    #[serde(default)]
    pub verification_goals: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledWorkflow {
    pub run: WorkflowRun,
    pub work_items: Vec<WorkItem>,
    pub dependencies: Vec<WorkItemDependency>,
}

pub fn compile_work_plan(
    requirement_id: &str,
    project_id: &str,
    source_revision: u32,
    change_spec: ChangeSpec,
    plan: WorkPlan,
) -> Result<CompiledWorkflow, AppError> {
    validate_change_spec(&change_spec, None)?;
    validate_plan(&plan, &change_spec)?;

    let now = Utc::now();
    let run_id = new_workflow_id("run");
    let work_items = plan
        .work_items
        .iter()
        .enumerate()
        .map(|(position, planned)| WorkItem {
            id: format!("{run_id}:item:{}", planned.id),
            run_id: run_id.clone(),
            position: position as u32,
            objective: planned.objective.trim().to_owned(),
            scenario_refs: planned.scenario_refs.clone(),
            group: planned
                .group
                .as_ref()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
            scope_hints: planned.scope_hints.clone(),
            verification_goals: planned.verification_goals.clone(),
            status: WorkItemStatus::Pending,
            attempt_count: 0,
            accepted_attempt_id: None,
            lease_owner: None,
            lease_expires_at: None,
            version: 0,
            created_at: now,
            updated_at: now,
        })
        .collect::<Vec<_>>();
    let dependencies = plan
        .work_items
        .iter()
        .flat_map(|item| {
            item.depends_on.iter().map(|dependency| WorkItemDependency {
                work_item_id: format!("{run_id}:item:{}", item.id),
                depends_on_id: format!("{run_id}:item:{dependency}"),
            })
        })
        .collect();

    Ok(CompiledWorkflow {
        run: WorkflowRun {
            id: run_id,
            requirement_id: requirement_id.to_owned(),
            project_id: project_id.to_owned(),
            status: WorkflowRunStatus::Running,
            change_spec,
            design_notes: plan.design_notes,
            plan_summary: plan.summary.trim().to_owned(),
            source_revision,
            base_head: None,
            integration_branch: None,
            integration_worktree: None,
            final_commit: None,
            rescue_used: false,
            rescue_attempt_id: None,
            blocked_reason: None,
            paused_operation: None,
            version: 0,
            created_at: now,
            updated_at: now,
            completed_at: None,
        },
        work_items,
        dependencies,
    })
}

pub fn change_spec_from_requirement(requirement: &Requirement) -> Result<ChangeSpec, AppError> {
    let spec = requirement
        .draft
        .clone()
        .ok_or_else(|| AppError::bad_request("需求尚未形成 ChangeSpec"))?;
    validate_change_spec(&spec, Some(requirement))?;
    Ok(spec)
}

pub fn validate_change_spec(
    spec: &ChangeSpec,
    requirement: Option<&Requirement>,
) -> Result<(), AppError> {
    if spec.intent.trim().is_empty() {
        return Err(AppError::bad_request("ChangeSpec intent 不能为空"));
    }
    if spec.acceptance_scenarios.is_empty() {
        return Err(AppError::bad_request("ChangeSpec 至少需要一个行为场景"));
    }
    let mut scenario_ids = HashSet::new();
    for scenario in &spec.acceptance_scenarios {
        validate_scenario(scenario)?;
        if !scenario_ids.insert(scenario.id.as_str()) {
            return Err(AppError::bad_request(format!(
                "行为场景 ID 重复：{}",
                scenario.id
            )));
        }
    }
    let mut constraint_ids = HashSet::new();
    for constraint in &spec.explicit_constraints {
        validate_identifier(&constraint.id, "显式约束")?;
        if constraint.statement.trim().is_empty()
            || constraint.source_message_id.trim().is_empty()
            || constraint.source_quote.trim().is_empty()
            || !constraint_ids.insert(constraint.id.as_str())
        {
            return Err(AppError::bad_request(
                "显式约束必须包含唯一 ID、原消息 ID 和原文摘录",
            ));
        }
        if let Some(requirement) = requirement {
            let source = requirement
                .messages
                .iter()
                .enumerate()
                .find(|(index, message)| {
                    format!("message-{}", index + 1) == constraint.source_message_id
                        && message.role == RequirementMessageRole::User
                })
                .ok_or_else(|| {
                    AppError::bad_request(format!(
                        "显式约束 {} 引用了不存在的用户消息",
                        constraint.id
                    ))
                })?;
            if !source.1.content.contains(constraint.source_quote.trim()) {
                return Err(AppError::bad_request(format!(
                    "显式约束 {} 的原文摘录与用户消息不匹配",
                    constraint.id
                )));
            }
        }
    }
    Ok(())
}

fn validate_scenario(scenario: &AcceptanceScenario) -> Result<(), AppError> {
    validate_identifier(&scenario.id, "行为场景")?;
    for (label, value) in [
        ("given", &scenario.given),
        ("when", &scenario.when),
        ("then", &scenario.then),
    ] {
        let value = value.trim();
        if value.is_empty() {
            return Err(AppError::bad_request(format!(
                "行为场景 {} 的 {label} 不能为空",
                scenario.id
            )));
        }
        if let Some(reason) = forbidden_behavior_detail(value) {
            return Err(AppError::bad_request(format!(
                "行为场景 {} 包含实现细节（{reason}）；用户明确指定的技术限制必须放入 explicit_constraints",
                scenario.id
            )));
        }
    }
    Ok(())
}

fn forbidden_behavior_detail(value: &str) -> Option<&'static str> {
    let lower = value.to_ascii_lowercase();
    if value.contains("```") || value.contains('`') {
        return Some("代码片段");
    }
    if [
        "npm ", "npx ", "cargo ", "pytest", "go test", "git ", "rg ", "grep ",
    ]
    .iter()
    .any(|token| lower.contains(token))
    {
        return Some("命令");
    }
    if lower.contains("--") || lower.contains("selector") || lower.contains("css var") {
        return Some("CSS selector/custom property");
    }
    if ["src/", "frontend/", "backend/", "tests/", "docs/"]
        .iter()
        .any(|prefix| lower.contains(prefix))
        || [".rs", ".ts", ".tsx", ".js", ".jsx", ".css", ".py", ".go"]
            .iter()
            .any(|suffix| lower.contains(suffix))
    {
        return Some("仓库路径或文件名");
    }
    None
}

fn validate_plan(plan: &WorkPlan, spec: &ChangeSpec) -> Result<(), AppError> {
    if plan.summary.trim().is_empty() {
        return Err(AppError::bad_request("工作计划摘要不能为空"));
    }
    if plan.work_items.is_empty() || plan.work_items.len() > MAX_WORK_ITEMS {
        return Err(AppError::bad_request(format!(
            "真实工作项数量必须在 1..={MAX_WORK_ITEMS} 之间"
        )));
    }
    let scenario_ids = spec
        .acceptance_scenarios
        .iter()
        .map(|scenario| scenario.id.as_str())
        .collect::<HashSet<_>>();
    let mut covered = HashSet::new();
    let mut ids = HashSet::new();
    for item in &plan.work_items {
        validate_identifier(&item.id, "工作项")?;
        if !ids.insert(item.id.as_str()) {
            return Err(AppError::bad_request(format!(
                "工作项 ID 重复：{}",
                item.id
            )));
        }
        if item.objective.trim().is_empty() || item.scenario_refs.is_empty() {
            return Err(AppError::bad_request(format!(
                "工作项 {} 必须包含 objective 和 scenario_refs",
                item.id
            )));
        }
        let mut own_refs = HashSet::new();
        for scenario_ref in &item.scenario_refs {
            if !scenario_ids.contains(scenario_ref.as_str()) {
                return Err(AppError::bad_request(format!(
                    "工作项 {} 引用了不存在的行为场景 {}",
                    item.id, scenario_ref
                )));
            }
            if !own_refs.insert(scenario_ref.as_str()) {
                return Err(AppError::bad_request(format!(
                    "工作项 {} 重复引用行为场景 {}",
                    item.id, scenario_ref
                )));
            }
            covered.insert(scenario_ref.as_str());
        }
        validate_scope_hints(item)?;
    }
    if covered != scenario_ids {
        let missing = scenario_ids
            .difference(&covered)
            .copied()
            .collect::<Vec<_>>()
            .join("、");
        return Err(AppError::bad_request(format!(
            "工作计划未覆盖行为场景：{missing}"
        )));
    }
    validate_dependencies(&plan.work_items, &ids)
}

fn validate_dependencies(items: &[PlannedWorkItem], ids: &HashSet<&str>) -> Result<(), AppError> {
    let mut incoming = ids
        .iter()
        .map(|id| ((*id).to_owned(), 0usize))
        .collect::<HashMap<_, _>>();
    let mut outgoing = HashMap::<&str, Vec<&str>>::new();
    for item in items {
        let mut unique = HashSet::new();
        for dependency in &item.depends_on {
            if dependency == &item.id
                || !ids.contains(dependency.as_str())
                || !unique.insert(dependency.as_str())
            {
                return Err(AppError::bad_request(format!(
                    "工作项 {} 包含无效依赖 {}",
                    item.id, dependency
                )));
            }
            *incoming.get_mut(item.id.as_str()).expect("known item") += 1;
            outgoing
                .entry(dependency.as_str())
                .or_default()
                .push(item.id.as_str());
        }
    }
    let mut queue = incoming
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(id.clone()))
        .collect::<VecDeque<_>>();
    let mut visited = 0;
    while let Some(id) = queue.pop_front() {
        visited += 1;
        for dependent in outgoing.get(id.as_str()).into_iter().flatten() {
            let count = incoming.get_mut(*dependent).expect("known dependent");
            *count -= 1;
            if *count == 0 {
                queue.push_back((*dependent).to_owned());
            }
        }
    }
    if visited != items.len() {
        return Err(AppError::bad_request("工作项依赖包含环"));
    }
    Ok(())
}

fn validate_scope_hints(item: &PlannedWorkItem) -> Result<(), AppError> {
    let mut paths = HashSet::new();
    for path in &item.scope_hints {
        validate_repository_path(path)?;
        if !paths.insert(path.as_str()) {
            return Err(AppError::bad_request(format!(
                "工作项 {} 的 scope_hints 包含重复路径 {}",
                item.id, path
            )));
        }
    }
    Ok(())
}

fn validate_identifier(identifier: &str, label: &str) -> Result<(), AppError> {
    let valid = !identifier.is_empty()
        && identifier.len() <= 64
        && identifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "{label} ID 只能包含字母、数字、-、_，且不超过 64 字符"
        )))
    }
}

fn validate_repository_path(path: &str) -> Result<(), AppError> {
    let path = Path::new(path);
    let safe = !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path.components().all(|component| {
            matches!(component, Component::Normal(_)) && component.as_os_str() != ".raccoon-node"
        });
    if safe {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "scope_hints 必须是安全的仓库相对路径",
        ))
    }
}

pub fn may_run_in_parallel(left: &WorkItem, right: &WorkItem) -> bool {
    left.group.is_some()
        && left.group == right.group
        && !left.scope_hints.is_empty()
        && !right.scope_hints.is_empty()
        && left.scope_hints.iter().all(|left_path| {
            right
                .scope_hints
                .iter()
                .all(|right_path| !paths_overlap(left_path, right_path))
        })
}

fn paths_overlap(left: &str, right: &str) -> bool {
    let left = Path::new(left);
    let right = Path::new(right);
    left == right || left.starts_with(right) || right.starts_with(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ChangeSpec {
        ChangeSpec {
            intent: "改善主页面体验".to_owned(),
            acceptance_scenarios: vec![AcceptanceScenario {
                id: "main-page".to_owned(),
                given: "用户打开应用".to_owned(),
                when: "用户查看主页面".to_owned(),
                then: "页面呈现清晰且现代的层级".to_owned(),
            }],
            explicit_constraints: Vec::new(),
            non_goals: Vec::new(),
        }
    }

    fn plan() -> WorkPlan {
        WorkPlan {
            summary: "交付主页面体验".to_owned(),
            design_notes: Vec::new(),
            work_items: vec![PlannedWorkItem {
                id: "main-page".to_owned(),
                objective: "交付完整的主页面体验".to_owned(),
                scenario_refs: vec!["main-page".to_owned()],
                depends_on: Vec::new(),
                group: None,
                scope_hints: vec!["frontend".to_owned()],
                verification_goals: vec!["用户可以完成主要浏览流程".to_owned()],
            }],
        }
    }

    #[test]
    fn compiler_creates_behavior_slices_without_stages() {
        let compiled = compile_work_plan("req", "current", 1, spec(), plan()).unwrap();
        assert_eq!(compiled.work_items.len(), 1);
        assert_eq!(compiled.work_items[0].scenario_refs, ["main-page"]);
    }

    #[test]
    fn behavior_scenarios_reject_implementation_details() {
        for detail in [
            "页面使用 --stagger-delay 呈现",
            "修改 frontend/src/App.tsx",
            "运行 npm run check 后显示页面",
            "调用 `use:link` 完成跳转",
        ] {
            let mut value = spec();
            value.acceptance_scenarios[0].then = detail.to_owned();
            assert!(validate_change_spec(&value, None).is_err(), "{detail}");
        }
    }

    #[test]
    fn every_scenario_must_be_covered() {
        let mut value = spec();
        value.acceptance_scenarios.push(AcceptanceScenario {
            id: "secondary".to_owned(),
            given: "用户查看次要区域".to_owned(),
            when: "用户浏览内容".to_owned(),
            then: "信息仍然容易理解".to_owned(),
        });
        assert!(compile_work_plan("req", "current", 1, value, plan()).is_err());
    }
}
