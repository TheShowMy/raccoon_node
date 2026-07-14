/// 稳定 prompt 资源（全局 prompt、skill prompt 等）的最大字节数。
pub const MAX_STABLE_SOURCE_BYTES: usize = 16 * 1024;
/// 单次请求最多引用的文件数量。
pub const MAX_REFERENCE_FILES: usize = 8;
/// 单个引用文件内联的最大字节数。
pub const MAX_INLINE_REFERENCE_BYTES: usize = 32 * 1024;
/// 单次请求中所有引用文件累计内联的最大字节数。
pub const MAX_INLINE_REFERENCE_TOTAL_BYTES: usize = 128 * 1024;
/// 单次请求最多内联的图片数量。
pub const MAX_PROMPT_IMAGES: usize = 3;
/// 单次请求中所有内联图片累计的最大字节数。
pub const MAX_PROMPT_IMAGE_TOTAL_BYTES: usize = 10 * 1024 * 1024;
/// 单个依赖任务输出截断后的最大字符数。
pub const MAX_DEPENDENCY_OUTPUT_CHARS: usize = 600;
/// 所有依赖任务输出拼接后的最大字符数。
pub const MAX_DEPENDENCY_CONTEXT_CHARS: usize = 2400;
/// 单条审核反馈的最大字符数。
pub const MAX_REVIEW_FEEDBACK_CHARS: usize = 2_000;
/// 所有审核反馈累计的最大字符数。
pub const MAX_REVIEW_FEEDBACK_TOTAL_CHARS: usize = 6_000;
/// 恢复指导方案的最大字符数。
pub const MAX_RECOVERY_GUIDANCE_CHARS: usize = 3_000;
/// 按 Unicode 字符截断字符串，并在截断时追加标记。
/// 返回 `(截断后文本, 是否被截断)`。首尾空白会被 `trim`。
pub fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    let value = value.trim();
    if value.chars().count() <= max_chars {
        return (value.to_owned(), false);
    }
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n...（已截断）");
    (truncated, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_prompt_resources_stay_bounded() {
        for resource in [
            include_str!("../../prompts/global/raccoon.md"),
            include_str!("../../prompts/skills/requirement_coordinator.md"),
            include_str!("../../prompts/skills/execution_planner.md"),
            include_str!("../../prompts/skills/implementation_runner.md"),
            include_str!("../../prompts/skills/code_reviewer.md"),
        ] {
            assert!(resource.len() <= MAX_STABLE_SOURCE_BYTES);
        }
    }

    #[test]
    fn truncate_chars_preserves_short_text() {
        let (text, truncated) = truncate_chars("hello", 10);
        assert_eq!(text, "hello");
        assert!(!truncated);
    }

    #[test]
    fn truncate_chars_adds_marker() {
        let (text, truncated) = truncate_chars("hello world", 5);
        assert!(truncated);
        assert!(text.starts_with("hello"));
        assert!(text.contains("已截断"));
    }

    #[test]
    fn truncate_chars_trims_whitespace() {
        let (text, _) = truncate_chars("  hello  ", 10);
        assert_eq!(text, "hello");
    }
}
