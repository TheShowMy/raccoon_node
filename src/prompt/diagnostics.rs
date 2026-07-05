use serde::Serialize;
use serde_json::{Value, json};

use super::sources::PromptSource;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromptDiagnostics {
    pub role: String,
    pub contract_id: Option<String>,
    pub chars: usize,
    pub estimated_tokens: Option<usize>,
    pub source_count: usize,
    pub included_count: usize,
    pub empty_count: usize,
    pub missing_count: usize,
    pub truncated_count: usize,
    pub sources: Vec<PromptSource>,
}

impl PromptDiagnostics {
    pub(crate) fn new(
        role: impl Into<String>,
        contract_id: Option<String>,
        markdown: &str,
        sources: Vec<PromptSource>,
    ) -> Self {
        let chars = markdown.chars().count();
        Self {
            role: role.into(),
            contract_id,
            chars,
            estimated_tokens: Some(chars.div_ceil(4)),
            source_count: sources.len(),
            included_count: sources.iter().filter(|source| source.included).count(),
            empty_count: sources.iter().filter(|source| source.empty).count(),
            missing_count: sources.iter().filter(|source| source.missing).count(),
            truncated_count: sources.iter().filter(|source| source.truncated).count(),
            sources,
        }
    }
}

pub(crate) fn attach_prompt_diagnostics(
    trace: Option<Value>,
    diagnostics: &PromptDiagnostics,
) -> Option<Value> {
    let prompt = serde_json::to_value(diagnostics).ok()?;
    let mut root = trace.unwrap_or_else(|| {
        json!({
            "type": "pi_trace",
            "version": 1,
            "trace": {}
        })
    });
    if !root.is_object() {
        return Some(root);
    }
    if root.get("trace").is_none() || !root.get("trace").is_some_and(Value::is_object) {
        root["trace"] = json!({});
    }
    root["trace"]["prompt"] = prompt;
    Some(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::{PromptSource, PromptSourceKind};

    #[test]
    fn diagnostics_counts_sources() {
        let sources = vec![
            PromptSource::included(PromptSourceKind::Skill, "skill", "hello"),
            PromptSource::missing(PromptSourceKind::Contract, "contract", "missing"),
        ];
        let diagnostics =
            PromptDiagnostics::new("role", Some("contract".to_owned()), "hello", sources);

        assert_eq!(diagnostics.source_count, 2);
        assert_eq!(diagnostics.included_count, 1);
        assert_eq!(diagnostics.missing_count, 1);
    }

    #[test]
    fn attaches_prompt_under_trace() {
        let source = PromptSource::included(PromptSourceKind::Skill, "skill", "hello");
        let diagnostics = PromptDiagnostics::new("role", None, "hello", vec![source]);
        let trace = attach_prompt_diagnostics(None, &diagnostics).unwrap();

        assert_eq!(trace.pointer("/trace/prompt/role"), Some(&json!("role")));
        assert!(trace.pointer("/trace/prompt/sources/0/preview").is_some());
    }
}
