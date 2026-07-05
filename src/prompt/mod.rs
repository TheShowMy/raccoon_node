mod contracts;
mod diagnostics;
mod renderer;
mod sections;
mod sources;

pub use diagnostics::PromptDiagnostics;
pub use renderer::RenderedPrompt;
pub use sections::{
    PromptSection, SectionError, SectionKind, format_section, parse_sections, replace_section,
};
pub use sources::{PromptSource, PromptSourceKind};

pub(crate) use contracts::{PromptContract, contract_text};
pub(crate) use diagnostics::attach_prompt_diagnostics;
pub(crate) use renderer::PromptRenderer;
