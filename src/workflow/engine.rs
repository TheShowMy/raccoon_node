use std::path::Path;

use crate::models::RequirementModelTier;

use super::{
    FindingStatus, ReviewAngle, WorkItem, WorkItemStatus, WorkflowAttemptKind,
    WorkflowReviewFinding, WorkflowSnapshot,
};

pub const WORK_ITEM_LEASE_SECONDS: i64 = 15 * 60;
pub const MAX_NORMAL_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttemptPolicy {
    pub kind: WorkflowAttemptKind,
    pub model_tier: RequirementModelTier,
}

pub fn next_attempt_policy(item: &WorkItem) -> Option<AttemptPolicy> {
    match item.attempt_count {
        0 => Some(AttemptPolicy {
            kind: WorkflowAttemptKind::Implementation,
            model_tier: RequirementModelTier::Low,
        }),
        1 => Some(AttemptPolicy {
            kind: WorkflowAttemptKind::Fix,
            model_tier: RequirementModelTier::Low,
        }),
        2 => Some(AttemptPolicy {
            kind: WorkflowAttemptKind::Fix,
            model_tier: RequirementModelTier::High,
        }),
        _ => None,
    }
}

pub fn required_review_angles_for_diff(paths: &[String], diff: &str) -> Vec<ReviewAngle> {
    let mut angles = vec![ReviewAngle::Correctness];
    let source_change = paths.iter().any(|path| !is_documentation(path));
    if source_change {
        angles.push(ReviewAngle::Quality);
    }
    if (paths.is_empty() && !diff.trim().is_empty())
        || paths.iter().any(|path| is_security_sensitive(path))
        || diff_contains_sensitive_code(diff)
    {
        angles.push(ReviewAngle::Security);
    }
    angles
}

fn is_documentation(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    path.starts_with("docs/")
        || path.ends_with(".md")
        || path.ends_with(".txt")
        || path.ends_with(".rst")
}

fn is_security_sensitive(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    [
        "auth",
        "permission",
        "session",
        "security",
        "network",
        "process",
        "shell",
        "git",
        "filesystem",
        "database",
        "migration",
        "config",
        "dependency",
        "build",
        "release",
        "ci",
        "concurr",
        "platform",
    ]
    .iter()
    .any(|needle| path.contains(needle))
        || [
            "cargo.toml",
            "package.json",
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
        ]
        .iter()
        .any(|name| path.ends_with(name))
}

fn diff_contains_sensitive_code(diff: &str) -> bool {
    let lower = diff.to_ascii_lowercase();
    [
        "unsafe ",
        "std::process",
        "child_process",
        "command::new",
        "shell:",
        "chmod",
        "authorization",
        "password",
        "token",
        "sql",
        "pathbuf",
        "symlink",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub fn all_work_items_accepted(snapshot: &WorkflowSnapshot) -> bool {
    !snapshot.work_items.is_empty()
        && snapshot
            .work_items
            .iter()
            .all(|item| item.status == WorkItemStatus::Accepted)
}

pub fn latest_open_blockers(snapshot: &WorkflowSnapshot) -> Vec<WorkflowReviewFinding> {
    snapshot
        .findings
        .iter()
        .filter(|finding| finding.priority.is_blocking() && finding.status == FindingStatus::Open)
        .cloned()
        .collect()
}

pub fn choose_fix_work_item<'a>(
    snapshot: &'a WorkflowSnapshot,
    findings: &[WorkflowReviewFinding],
) -> Option<&'a WorkItem> {
    for finding in findings
        .iter()
        .filter(|finding| finding.priority.is_blocking() && finding.status == FindingStatus::Open)
    {
        let Some(path) = finding.path.as_deref() else {
            continue;
        };
        if let Some(item) = snapshot.work_items.iter().find(|item| {
            item.scope_hints
                .iter()
                .any(|scope| paths_overlap(scope, path))
        }) {
            return Some(item);
        }
    }
    snapshot
        .work_items
        .iter()
        .max_by_key(|item| (item.position, item.attempt_count))
}

pub fn validation_failure_summary(command: &str, output: &str) -> String {
    let mut summary = format!("仓库原生验证失败：{command}");
    let output = output.trim();
    if !output.is_empty() {
        summary.push('；');
        summary.extend(output.chars().take(480));
    }
    summary
}

fn paths_overlap(left: &str, right: &str) -> bool {
    let left = Path::new(left);
    let right = Path::new(right);
    left == right || left.starts_with(right) || right.starts_with(left)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn item(attempt_count: u32) -> WorkItem {
        let now = Utc::now();
        WorkItem {
            id: "item".to_owned(),
            run_id: "run".to_owned(),
            position: 0,
            objective: "交付行为".to_owned(),
            scenario_refs: vec!["scenario".to_owned()],
            group: None,
            scope_hints: vec!["src".to_owned()],
            verification_goals: Vec::new(),
            status: WorkItemStatus::Pending,
            attempt_count,
            actual_attempt_count: attempt_count,
            accepted_attempt_id: None,
            lease_owner: None,
            lease_expires_at: None,
            version: 0,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn attempt_policy_has_low_implementation_low_fix_and_high_fix() {
        assert_eq!(
            next_attempt_policy(&item(0)).unwrap().kind,
            WorkflowAttemptKind::Implementation
        );
        assert_eq!(
            next_attempt_policy(&item(1)).unwrap().model_tier,
            RequirementModelTier::Low
        );
        assert_eq!(
            next_attempt_policy(&item(2)).unwrap().model_tier,
            RequirementModelTier::High
        );
        assert!(next_attempt_policy(&item(MAX_NORMAL_ATTEMPTS)).is_none());
    }

    #[test]
    fn review_angles_are_risk_adaptive() {
        assert_eq!(
            required_review_angles_for_diff(&["docs/guide.md".to_owned()], ""),
            [ReviewAngle::Correctness]
        );
        assert_eq!(
            required_review_angles_for_diff(&["frontend/src/App.tsx".to_owned()], "").len(),
            2
        );
        assert_eq!(
            required_review_angles_for_diff(&["src/auth/session.rs".to_owned()], "").len(),
            3
        );
    }
}
