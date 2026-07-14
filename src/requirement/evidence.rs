use serde::Serialize;

use crate::{
    error::AppError,
    models::{ExplicitConstraint, RequirementMessage, RequirementMessageRole},
};

use crate::models::ChangeSpec;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RequirementEvidence {
    pub message_id: String,
    pub content: String,
}

pub fn requirement_evidence_index(messages: &[RequirementMessage]) -> Vec<RequirementEvidence> {
    messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role == RequirementMessageRole::User)
        .filter(|(_, message)| !message.content.trim().is_empty())
        .map(|(index, message)| RequirementEvidence {
            message_id: format!("message-{}", index + 1),
            content: message.content.trim().to_owned(),
        })
        .collect()
}

pub fn format_requirement_evidence_index(messages: &[RequirementMessage]) -> String {
    let evidence = requirement_evidence_index(messages);
    format!(
        "用户显式技术约束只能引用以下证据。source_message_id 必须复制 message_id；source_quote 必须是对应 content 中连续、逐字一致的片段。\n{}",
        serde_json::to_string(&evidence).expect("requirement evidence serializes")
    )
}

pub fn validate_constraint_evidence(
    constraints: &[ExplicitConstraint],
    messages: &[RequirementMessage],
) -> Result<(), AppError> {
    let allowed = requirement_evidence_index(messages)
        .into_iter()
        .map(|evidence| evidence.message_id)
        .collect::<Vec<_>>();

    for (index, constraint) in constraints.iter().enumerate() {
        let Some(message_index) = constraint
            .source_message_id
            .strip_prefix("message-")
            .and_then(|value| value.parse::<usize>().ok())
            .and_then(|value| value.checked_sub(1))
        else {
            return Err(AppError::bad_request(format!(
                "explicit_constraints[{index}].source_message_id 不合法：{}；允许值：{}",
                constraint.source_message_id,
                allowed.join(", ")
            )));
        };
        let Some(message) = messages.get(message_index) else {
            return Err(AppError::bad_request(format!(
                "explicit_constraints[{index}].source_message_id 引用了不存在的用户消息：{}；允许值：{}",
                constraint.source_message_id,
                allowed.join(", ")
            )));
        };
        if message.role != RequirementMessageRole::User {
            return Err(AppError::bad_request(format!(
                "explicit_constraints[{index}].source_message_id 不是用户消息：{}；允许值：{}",
                constraint.source_message_id,
                allowed.join(", ")
            )));
        }
        if !message.content.contains(constraint.source_quote.trim()) {
            return Err(AppError::bad_request(format!(
                "explicit_constraints[{index}].source_quote 不是 {} 中连续、逐字一致的原文",
                constraint.source_message_id
            )));
        }
    }
    Ok(())
}

pub fn change_spec_semantics_equal(left: &ChangeSpec, right: &ChangeSpec) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    for constraint in &mut left.explicit_constraints {
        constraint.source_message_id.clear();
        constraint.source_quote.clear();
    }
    for constraint in &mut right.explicit_constraints {
        constraint.source_message_id.clear();
        constraint.source_quote.clear();
    }
    left == right
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn message(role: RequirementMessageRole, content: &str) -> RequirementMessage {
        RequirementMessage {
            role,
            content: content.to_owned(),
            references: Vec::new(),
            images: Vec::new(),
            metadata: None,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn evidence_ids_follow_the_persisted_message_positions() {
        let messages = vec![
            message(RequirementMessageRole::User, "初始需求"),
            message(RequirementMessageRole::Assistant, "需要澄清"),
            message(RequirementMessageRole::Trace, "trace"),
            message(RequirementMessageRole::User, "策略：强制 WebGL"),
        ];
        let evidence = requirement_evidence_index(&messages);
        assert_eq!(evidence[0].message_id, "message-1");
        assert_eq!(evidence[1].message_id, "message-4");
    }

    #[test]
    fn constraint_evidence_rejects_guessed_ids_and_non_exact_quotes() {
        let messages = vec![message(
            RequirementMessageRole::User,
            "期望的修复策略是什么？：强制 WebGL 并优化检测",
        )];
        let mut constraint = ExplicitConstraint {
            id: "strategy".to_owned(),
            statement: "强制 WebGL".to_owned(),
            source_message_id: "clarification_answer".to_owned(),
            source_quote: "强制 WebGL 并优化检测".to_owned(),
        };
        assert!(validate_constraint_evidence(&[constraint.clone()], &messages).is_err());

        constraint.source_message_id = "message-1".to_owned();
        constraint.source_quote = "策略：优化检测".to_owned();
        assert!(validate_constraint_evidence(&[constraint.clone()], &messages).is_err());

        constraint.source_quote = "强制 WebGL 并优化检测".to_owned();
        validate_constraint_evidence(&[constraint], &messages).unwrap();
    }
}
