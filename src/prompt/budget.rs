pub const MAX_STABLE_SOURCE_BYTES: usize = 16 * 1024;
pub const MAX_REFERENCE_FILES: usize = 8;
pub const MAX_INLINE_REFERENCE_BYTES: u64 = 32 * 1024;
pub const MAX_INLINE_REFERENCE_TOTAL_BYTES: u64 = 128 * 1024;
pub const MAX_PROMPT_IMAGES: usize = 3;
pub const MAX_PROMPT_IMAGE_TOTAL_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_DEPENDENCY_OUTPUT_CHARS: usize = 600;
pub const MAX_DEPENDENCY_CONTEXT_CHARS: usize = 2400;
pub const MAX_REVIEW_FEEDBACK_CHARS: usize = 2_000;
pub const MAX_REVIEW_FEEDBACK_TOTAL_CHARS: usize = 6_000;
pub const MAX_RECOVERY_GUIDANCE_CHARS: usize = 3_000;
pub const MAX_JSON_REPAIR_EXCERPT_CHARS: usize = 2_000;

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
}
