use super::{PromptDiagnostics, PromptSource, PromptSourceDelivery, PromptSourceKind};

#[derive(Debug, Clone)]
pub struct RenderedPrompt {
    pub markdown: String,
    pub sources: Vec<PromptSource>,
    pub diagnostics: PromptDiagnostics,
}

#[derive(Debug, Clone)]
pub(crate) struct PromptRenderer {
    role: String,
    contract_id: Option<String>,
    parts: Vec<PromptPart>,
}

#[derive(Debug, Clone)]
struct PromptPart {
    source: PromptSource,
    content: String,
}

impl PromptRenderer {
    pub(crate) fn new(role: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            contract_id: None,
            parts: Vec::new(),
        }
    }

    pub(crate) fn contract_id(mut self, contract_id: impl Into<String>) -> Self {
        self.contract_id = Some(contract_id.into());
        self
    }

    pub(crate) fn add_source(
        mut self,
        kind: PromptSourceKind,
        label: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        let content = content.into();
        let source = PromptSource::included(kind, label, &content);
        self.parts.push(PromptPart { source, content });
        self
    }

    pub(crate) fn add_optional_source(
        mut self,
        kind: PromptSourceKind,
        label: impl Into<String>,
        content: Option<String>,
    ) -> Self {
        let source = PromptSource::optional(kind, label, content.as_deref());
        self.parts.push(PromptPart {
            source,
            content: content.unwrap_or_default(),
        });
        self
    }

    pub(crate) fn add_reference_source(
        mut self,
        label: impl Into<String>,
        content: impl Into<String>,
        delivery: PromptSourceDelivery,
        bytes: usize,
    ) -> Self {
        let content = content.into();
        let source = PromptSource::included(PromptSourceKind::ReferenceContext, label, &content)
            .with_delivery(delivery, bytes);
        self.parts.push(PromptPart { source, content });
        self
    }

    pub(crate) fn render(self) -> RenderedPrompt {
        let mut markdown = String::new();
        let mut sources = Vec::with_capacity(self.parts.len());
        for part in self.parts {
            if part.source.included && !part.content.is_empty() {
                if !markdown.is_empty() && !markdown.ends_with('\n') {
                    markdown.push('\n');
                }
                markdown.push_str(&part.content);
            }
            sources.push(part.source);
        }
        let diagnostics =
            PromptDiagnostics::new(self.role, self.contract_id, &markdown, sources.clone());
        RenderedPrompt {
            markdown,
            sources,
            diagnostics,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_order_controls_markdown_order() {
        let rendered = PromptRenderer::new("role")
            .add_source(PromptSourceKind::Skill, "first", "first")
            .add_source(PromptSourceKind::TaskContext, "second", "second")
            .render();

        assert_eq!(rendered.markdown, "first\nsecond");
        assert_eq!(rendered.sources[0].label, "first");
        assert_eq!(rendered.sources[1].label, "second");
    }

    #[test]
    fn optional_empty_source_is_not_rendered() {
        let rendered = PromptRenderer::new("role")
            .add_source(PromptSourceKind::Skill, "first", "first")
            .add_optional_source(
                PromptSourceKind::ReferenceContext,
                "ref",
                Some(String::new()),
            )
            .render();

        assert_eq!(rendered.markdown, "first");
        assert_eq!(rendered.diagnostics.empty_count, 1);
        assert_eq!(rendered.diagnostics.included_count, 1);
    }

    #[test]
    fn reference_source_records_delivery_and_bytes() {
        let rendered = PromptRenderer::new("role")
            .add_reference_source(
                "large.rs",
                "<file path=\"large.rs\" bytes=\"65536\" inline=\"false\" />",
                PromptSourceDelivery::PathOnly,
                65536,
            )
            .render();

        let source = rendered
            .sources
            .iter()
            .find(|source| source.label == "large.rs")
            .expect("missing reference source");
        assert_eq!(source.delivery, Some(PromptSourceDelivery::PathOnly));
        assert_eq!(source.bytes, Some(65536));
    }
}
