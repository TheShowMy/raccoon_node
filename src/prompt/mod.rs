mod budget;
mod diagnostics;
mod renderer;
mod sections;
mod sources;

pub use budget::{
    MAX_DEPENDENCY_CONTEXT_CHARS, MAX_DEPENDENCY_OUTPUT_CHARS, MAX_INLINE_REFERENCE_BYTES,
    MAX_INLINE_REFERENCE_TOTAL_BYTES, MAX_PROMPT_IMAGE_TOTAL_BYTES, MAX_PROMPT_IMAGES,
    MAX_RECOVERY_GUIDANCE_CHARS, MAX_REFERENCE_FILES, MAX_REVIEW_FEEDBACK_CHARS,
    MAX_REVIEW_FEEDBACK_TOTAL_CHARS, MAX_STABLE_SOURCE_BYTES, truncate_chars,
};
pub use diagnostics::PromptDiagnostics;
pub use renderer::RenderedPrompt;
pub use sections::{
    PromptSection, SectionError, SectionKind, format_section, parse_sections, replace_section,
};
pub use sources::{PromptSource, PromptSourceDelivery, PromptSourceKind};

pub(crate) use diagnostics::attach_prompt_diagnostics;
pub(crate) use renderer::PromptRenderer;

/// 剥离 Markdown 文件顶部的 YAML frontmatter（如果存在）。
///
/// 匹配规则：以 `---` 开头，随后遇到单独一行的 `---` 结束。返回正文部分，
/// 并去除 frontmatter 后多余的空行。
pub fn strip_markdown_frontmatter(content: &str) -> &str {
    if !content.starts_with("---") {
        return content;
    }
    let after_prefix = &content[3..];
    let Some(end_idx) = after_prefix.find("\n---") else {
        return content;
    };
    let body_start = 3 + end_idx + 4;
    let body = &content[body_start..];
    body.trim_start()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_yaml_frontmatter() {
        let input = "---\nname: foo\n---\n\nbody\n";
        assert_eq!(strip_markdown_frontmatter(input), "body\n");
    }

    #[test]
    fn returns_unchanged_without_frontmatter() {
        let input = "no frontmatter\n";
        assert_eq!(strip_markdown_frontmatter(input), "no frontmatter\n");
    }

    #[test]
    fn returns_unchanged_when_closing_marker_missing() {
        let input = "---\nname: foo\n";
        assert_eq!(strip_markdown_frontmatter(input), input);
    }
}
