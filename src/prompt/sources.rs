use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptSourceDelivery {
    Inline,
    PathOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptSourceKind {
    Global,
    Skill,
    Contract,
    ProjectContext,
    RequirementContext,
    ExecutionContext,
    TaskContext,
    ReferenceContext,
    InlinePolicy,
    JsonRepairExcerpt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromptSource {
    pub kind: PromptSourceKind,
    pub label: String,
    pub included: bool,
    pub empty: bool,
    pub missing: bool,
    pub disabled_reason: Option<String>,
    pub chars: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<PromptSourceDelivery>,
    pub estimated_tokens: Option<usize>,
    pub truncated: bool,
    pub preview: String,
}

impl PromptSource {
    pub(crate) fn included(
        kind: PromptSourceKind,
        label: impl Into<String>,
        content: &str,
    ) -> Self {
        Self::new(kind, label, true, false, None, content, false)
    }

    pub(crate) fn optional(
        kind: PromptSourceKind,
        label: impl Into<String>,
        content: Option<&str>,
    ) -> Self {
        match content {
            Some(content) if !content.trim().is_empty() => Self::included(kind, label, content),
            Some(content) => Self::new(kind, label, false, false, None, content, false),
            None => Self::new(kind, label, false, true, None, "", false),
        }
    }

    pub(crate) fn with_delivery(mut self, delivery: PromptSourceDelivery, bytes: usize) -> Self {
        self.delivery = Some(delivery);
        self.bytes = Some(bytes);
        self
    }

    #[cfg(test)]
    pub(crate) fn missing(kind: PromptSourceKind, label: impl Into<String>, reason: &str) -> Self {
        Self::new(kind, label, false, true, Some(reason.to_owned()), "", false)
    }

    fn new(
        kind: PromptSourceKind,
        label: impl Into<String>,
        included: bool,
        missing: bool,
        disabled_reason: Option<String>,
        content: &str,
        truncated: bool,
    ) -> Self {
        let chars = content.chars().count();
        let empty = content.trim().is_empty();
        let has_content = included && !missing && !empty;
        Self {
            kind,
            label: label.into(),
            included,
            empty,
            missing,
            disabled_reason,
            chars,
            bytes: has_content.then_some(content.len()),
            delivery: has_content.then_some(PromptSourceDelivery::Inline),
            estimated_tokens: Some(estimate_tokens(chars)),
            truncated,
            preview: String::new(),
        }
    }
}

fn estimate_tokens(chars: usize) -> usize {
    chars.div_ceil(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_preview_is_empty_to_avoid_persisting_prompt_text() {
        let source = PromptSource::included(PromptSourceKind::Skill, "large", &"x".repeat(300));

        assert_eq!(source.chars, 300);
        assert!(source.preview.is_empty());
    }
}
