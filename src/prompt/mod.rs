mod budget;
mod contracts;
mod diagnostics;
mod renderer;
mod sections;
mod sources;

pub use budget::{
    MAX_DEPENDENCY_CONTEXT_CHARS, MAX_DEPENDENCY_OUTPUT_CHARS, MAX_INLINE_REFERENCE_BYTES,
    MAX_INLINE_REFERENCE_TOTAL_BYTES, MAX_JSON_REPAIR_EXCERPT_CHARS, MAX_PROMPT_IMAGE_TOTAL_BYTES,
    MAX_PROMPT_IMAGES, MAX_RECOVERY_GUIDANCE_CHARS, MAX_REFERENCE_FILES, MAX_REVIEW_FEEDBACK_CHARS,
    MAX_REVIEW_FEEDBACK_TOTAL_CHARS, MAX_STABLE_SOURCE_BYTES, truncate_chars,
};
pub use diagnostics::PromptDiagnostics;
pub use renderer::RenderedPrompt;
pub use sections::{
    PromptSection, SectionError, SectionKind, format_section, parse_sections, replace_section,
};
pub use sources::{PromptSource, PromptSourceDelivery, PromptSourceKind};

pub(crate) use contracts::{PromptContract, contract_text};
pub(crate) use diagnostics::attach_prompt_diagnostics;
pub(crate) use renderer::PromptRenderer;
