use std::{future::Future, pin::Pin, sync::atomic::AtomicU64};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::error::AppError;

pub static PI_RPC_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppData {
    pub projects: Vec<Project>,
    #[serde(default)]
    pub requirements: Vec<Requirement>,
    #[serde(default)]
    pub project_chats: Vec<ProjectChat>,
    pub settings_summary: SummaryNode,
    pub model_summary: SummaryNode,
    #[serde(default)]
    pub model_settings: ModelSettings,
    #[serde(default)]
    pub terminal_command_profiles: Vec<TerminalCommandProfile>,
}

impl Default for AppData {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            requirements: Vec::new(),
            project_chats: Vec::new(),
            settings_summary: SummaryNode {
                title: "设置".to_owned(),
                description: "基础设置待配置".to_owned(),
            },
            model_summary: SummaryNode {
                title: "模型设置".to_owned(),
                description: "默认模型待配置".to_owned(),
            },
            model_settings: ModelSettings::default(),
            terminal_command_profiles: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectChat {
    pub project_id: String,
    #[serde(default)]
    pub messages: Vec<ProjectChatMessage>,
    #[serde(default)]
    pub running: bool,
    pub error: Option<String>,
    #[serde(skip_serializing)]
    pub pi_session_file: Option<String>,
    #[serde(default)]
    pub requirement_summary: Option<ProjectRequirementSummary>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectChatMessage {
    pub role: ProjectChatMessageRole,
    pub content: String,
    #[serde(default)]
    pub references: Vec<FileReference>,
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectChatMessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectChatResponse {
    pub project_id: String,
    pub messages: Vec<ProjectChatMessage>,
    pub running: bool,
    pub error: Option<String>,
    pub requirement_summary: Option<ProjectRequirementSummary>,
    pub updated_at: DateTime<Utc>,
}

pub type ProjectRequirementSummary = RequirementDraft;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub git_url: String,
    pub local_path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CurrentProjectResponse {
    pub project: Project,
    pub theme_pack: String,
    pub theme_mode: crate::config::ThemeMode,
    pub publication_readiness: PublicationReadiness,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitProvider {
    GitHub,
    GitLab,
    #[default]
    Local,
}

impl GitProvider {
    pub fn from_origin(origin: &str) -> Self {
        let origin = origin.trim();
        if origin.is_empty() {
            return Self::Local;
        }
        let host = origin
            .strip_prefix("git@")
            .and_then(|rest| rest.split_once(':'))
            .map(|(host, _)| host)
            .or_else(|| {
                origin
                    .split_once("://")
                    .map(|(_, rest)| rest)
                    .and_then(|rest| rest.split('/').next())
                    .and_then(|authority| authority.rsplit('@').next())
            })
            .unwrap_or(origin);
        if host.eq_ignore_ascii_case("github.com") || host.ends_with(".github.com") {
            Self::GitHub
        } else if host.eq_ignore_ascii_case("gitlab.com") || host.contains("gitlab") {
            Self::GitLab
        } else {
            Self::Local
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicationReadiness {
    pub mode: String,
    pub provider: GitProvider,
    pub ready: bool,
    pub summary: String,
    pub issues: Vec<String>,
    pub notes: Vec<String>,
}

impl PublicationReadiness {
    pub fn local() -> Self {
        Self {
            mode: "local".to_owned(),
            provider: GitProvider::Local,
            ready: true,
            summary: "未配置 origin，将使用本地合并，不创建 PR。".to_owned(),
            issues: Vec::new(),
            notes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BasicSettings {
    pub theme_pack: String,
    pub theme_mode: crate::config::ThemeMode,
    pub host: String,
    pub port: u16,
    pub host_overridden: bool,
    pub port_overridden: bool,
    pub effective_host: String,
    pub effective_port: u16,
    pub restart_required: bool,
    pub commit_mode: crate::config::CommitMode,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct BasicSettingsUpdate {
    #[serde(default)]
    pub theme_pack: Option<String>,
    #[serde(default)]
    pub theme_mode: Option<crate::config::ThemeMode>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u32>,
    #[serde(default)]
    pub commit_mode: Option<crate::config::CommitMode>,
    #[serde(default)]
    pub confirmed_external: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Requirement {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub original_message: String,
    pub status: RequirementStatus,
    pub messages: Vec<RequirementMessage>,
    #[serde(default)]
    pub clarification_round: u32,
    #[serde(default)]
    pub clarifications: Vec<RequirementClarification>,
    pub draft: Option<RequirementDraft>,
    #[serde(default)]
    pub analysis_revision: u32,
    #[serde(default)]
    pub active_prompt: Option<RequirementPromptState>,
    #[serde(default)]
    pub clarification_history: Vec<RequirementClarificationRound>,
    #[serde(default)]
    pub execution_plan: Option<RequirementExecutionPlan>,
    #[serde(skip_serializing)]
    pub pi_session_file: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub queued_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    Analyzing,
    Clarifying,
    DraftReady,
    Planning,
    PlanReady,
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementMessage {
    pub role: RequirementMessageRole,
    pub content: String,
    #[serde(default)]
    pub references: Vec<FileReference>,
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RequirementMessageRole {
    User,
    Assistant,
    System,
    Trace,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementDraft {
    pub title: String,
    pub summary: String,
    pub acceptance_criteria: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RequirementPromptState {
    Clarification {
        prompt_id: String,
        revision: u32,
        round: u32,
        questions: Vec<RequirementClarification>,
    },
    Confirmation {
        prompt_id: String,
        revision: u32,
        draft: RequirementDraft,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementClarificationRound {
    pub round: u32,
    pub prompt_id: String,
    pub revision: u32,
    pub questions: Vec<RequirementClarification>,
    #[serde(default)]
    pub superseded: bool,
    #[serde(default)]
    pub answered_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementExecutionPlan {
    pub summary: String,
    pub tasks: Vec<RequirementExecutionTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementExecutionTask {
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub kind: RequirementTaskKind,
    #[serde(default)]
    pub model_tier: RequirementModelTier,
    #[serde(default = "default_task_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub pi_session_file: Option<String>,
    #[serde(default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub review_for: Option<String>,
    #[serde(default)]
    pub review_angle: Option<String>,
    #[serde(default)]
    pub review_status: RequirementReviewStatus,
    #[serde(default)]
    pub review_history: Vec<RequirementReviewRound>,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub execution_failure_count: u32,
    #[serde(default)]
    pub review_rejection_count: u32,
    #[serde(default)]
    pub recovery_stage: RequirementRecoveryStage,
    #[serde(default)]
    pub failure_summary: Option<String>,
    #[serde(default)]
    pub recovery_guidance: Option<String>,
    #[serde(default)]
    pub high_tier_execution_used: bool,
    #[serde(default)]
    pub last_review_feedback: Option<String>,
    #[serde(default)]
    pub pull_request_url: Option<String>,
    #[serde(default)]
    pub merged_into: Option<String>,
    #[serde(default)]
    pub cleanup_summary: Option<String>,
    #[serde(default)]
    pub execution_warning: Option<String>,
    #[serde(default)]
    pub trace: Option<Value>,
    pub status: RequirementTaskStatus,
    #[serde(default)]
    pub target_files: Vec<String>,
    pub result_summary: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementReviewRound {
    pub round: u32,
    pub implementation_attempt: u32,
    pub implementation_summary: String,
    pub status: RequirementReviewRoundStatus,
    pub started_at: DateTime<Utc>,
    #[serde(default)]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub reviews: Vec<RequirementReviewStep>,
    #[serde(default)]
    pub summary_conclusion: Option<RequirementReviewStatus>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementReviewStep {
    pub task_id: String,
    pub angle: String,
    pub status: RequirementReviewStatus,
    pub summary: String,
    #[serde(default)]
    pub failure_reason: Option<String>,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequirementReviewRoundStatus {
    #[default]
    Reviewing,
    Approved,
    Rejected,
}

fn default_task_timeout_seconds() -> u64 {
    90
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileReference {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImageAttachment {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptImage {
    pub data_base64: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequirementTaskKind {
    #[default]
    Implementation,
    Review,
    ReviewSummary,
    ReviewSubAgent,
    BranchMerge,
    MergeReview,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum RequirementModelTier {
    Low,
    #[default]
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequirementRecoveryStage {
    #[default]
    None,
    AutoRetry,
    GuidedRetry,
    HighTierExecution,
    Exhausted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequirementReviewStatus {
    #[default]
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequirementTaskStatus {
    Pending,
    Running,
    AwaitingReview,
    Fixing,
    Completed,
    Failed,
    Skipped,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementClarification {
    pub id: String,
    pub question: String,
    pub question_type: ClarificationQuestionType,
    pub options: Vec<ClarificationOption>,
    #[serde(default)]
    pub answer: Option<ClarificationAnswer>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClarificationQuestionType {
    SingleChoice,
    MultiChoice,
    FreeText,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClarificationOption {
    pub value: String,
    pub label: String,
    pub description: String,
    #[serde(default)]
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClarificationAnswer {
    pub selected_options: Vec<String>,
    pub custom_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectCanvasResponse {
    pub project: Project,
    pub active_requirement: Option<Requirement>,
    pub queued_requirements: Vec<Requirement>,
    pub completed_requirements: Vec<Requirement>,
    pub token_usage: Option<ProjectTokenUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequirementTaskDetailResponse {
    pub task: RequirementExecutionTask,
    pub reviews: Vec<RequirementExecutionTask>,
    pub dependencies: Vec<RequirementExecutionTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTranscriptPage {
    pub entries: Vec<SessionEntry>,
    pub next_before: Option<usize>,
    pub invalid_lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEntry {
    pub cursor: usize,
    pub source: String,
    pub line: usize,
    pub kind: String,
    pub id: Option<String>,
    pub role: Option<String>,
    pub timestamp: Option<String>,
    pub blocks: Vec<SessionContentBlock>,
    pub raw: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionContentBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    ToolResult {
        tool_call_id: String,
        name: String,
        output: String,
        diff: Option<String>,
        is_error: bool,
    },
    Unknown {
        block_type: String,
        raw: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFileContent {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalCommandProfile {
    pub id: String,
    pub name: String,
    pub command: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionStatus {
    Starting,
    Running,
    Exited,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalSession {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub command: Option<String>,
    pub status: TerminalSessionStatus,
    pub exit_code: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalAccessStatus {
    pub required: bool,
    pub authorized: bool,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TerminalAccessRequest {
    pub key: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TerminalLaunchRequest {
    pub command: Option<String>,
    pub title: Option<String>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TerminalCommandProfilesUpdate {
    pub profiles: Vec<TerminalCommandProfileUpdate>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TerminalCommandProfileUpdate {
    pub id: Option<String>,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalServerMessage {
    Output {
        data: String,
    },
    Status {
        status: TerminalSessionStatus,
        exit_code: Option<i32>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectTokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub context_tokens: u64,
    pub context_window: u64,
    pub context_percent: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RequirementConversationResponse {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: RequirementStatus,
    pub running: bool,
    pub items: Vec<RequirementConversationItem>,
    pub prompt: Option<RequirementConversationPrompt>,
    pub error: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RequirementConversationItem {
    User {
        id: String,
        text: String,
        references: Vec<FileReference>,
        images: Vec<ImageAttachment>,
        created_at: DateTime<Utc>,
    },
    Assistant {
        id: String,
        text: String,
        created_at: DateTime<Utc>,
    },
    Notice {
        id: String,
        level: RequirementNoticeLevel,
        text: String,
        created_at: DateTime<Utc>,
    },
    Process {
        id: String,
        title: String,
        status: RequirementProcessStatus,
        metadata: Option<Value>,
        created_at: DateTime<Utc>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RequirementNoticeLevel {
    Info,
    Warn,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RequirementProcessStatus {
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RequirementConversationPrompt {
    Clarification {
        round: u32,
        questions: Vec<RequirementClarification>,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        revision: Option<u32>,
    },
    Confirmation {
        draft: RequirementDraft,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        revision: Option<u32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SummaryNode {
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelSettings {
    pub low: ModelTierSetting,
    pub medium: ModelTierSetting,
    pub high: ModelTierSetting,
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            low: ModelTierSetting::default_with_level(ThinkingLevel::Low),
            medium: ModelTierSetting::default_with_level(ThinkingLevel::Medium),
            high: ModelTierSetting::default_with_level(ThinkingLevel::High),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelTierSetting {
    pub model_id: Option<String>,
    pub thinking_level: ThinkingLevel,
}

impl ModelTierSetting {
    pub fn default_with_level(thinking_level: ThinkingLevel) -> Self {
        Self {
            model_id: None,
            thinking_level,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

impl ThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PiModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub reasoning: bool,
}

#[derive(Debug, Serialize)]
pub struct ModelSettingsResponse {
    pub models: Vec<PiModel>,
    pub settings: ModelSettings,
    pub rpc_status: RpcStatus,
    pub rpc_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RpcStatus {
    Ready,
    Reconnecting,
    Error,
}

pub type ModelProviderFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<PiModel>, AppError>> + Send + 'a>>;
pub type RequirementAnalysisFuture<'a> =
    Pin<Box<dyn Future<Output = Result<RequirementAnalysisOutput, AppError>> + Send + 'a>>;
pub type RequirementPlanFuture<'a> =
    Pin<Box<dyn Future<Output = Result<RequirementExecutionPlan, AppError>> + Send + 'a>>;
pub type RequirementTaskExecutionFuture<'a> =
    Pin<Box<dyn Future<Output = Result<RequirementTaskExecutionOutput, AppError>> + Send + 'a>>;
pub type ProjectChatFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ProjectChatOutput, AppError>> + Send + 'a>>;
pub type ProjectRequirementSummaryFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ProjectRequirementSummaryOutput, AppError>> + Send + 'a>>;
pub type ModelProviderActionFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), AppError>> + Send + 'a>>;

pub trait ModelProvider: Send + Sync {
    fn available_models(&self) -> ModelProviderFuture<'_>;
    fn analyze_requirement(
        &self,
        input: RequirementAnalysisInput,
        events: Option<RequirementEventEmitter>,
    ) -> RequirementAnalysisFuture<'_>;
    fn plan_requirement_execution(
        &self,
        input: RequirementPlanInput,
        events: Option<RequirementEventEmitter>,
    ) -> RequirementPlanFuture<'_>;
    fn execute_requirement_task(
        &self,
        input: RequirementTaskExecutionInput,
        events: Option<RequirementEventEmitter>,
    ) -> RequirementTaskExecutionFuture<'_>;
    fn ask_project_chat(
        &self,
        _input: ProjectChatInput,
        _events: Option<ProjectChatEventEmitter>,
    ) -> ProjectChatFuture<'_> {
        Box::pin(async { Err(AppError::internal("项目问答暂不可用")) })
    }
    fn generate_project_requirement_summary(
        &self,
        _input: ProjectChatInput,
        _events: Option<ProjectChatEventEmitter>,
    ) -> ProjectRequirementSummaryFuture<'_> {
        Box::pin(async { Err(AppError::internal("需求说明生成暂不可用")) })
    }
    fn begin_project_chat(&self, _project_id: &str) -> ModelProviderActionFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn cancel_project_chat(&self, _project_id: &str) -> ModelProviderActionFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn release_project(&self, _project_id: &str) -> ModelProviderActionFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    /// Cancel a running requirement analysis for the given project.
    fn cancel_requirement_analysis(&self, _project_id: &str) -> ModelProviderActionFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn respond_requirement_interaction(
        &self,
        _project_id: &str,
        _request_id: &str,
        _response: Value,
    ) -> ModelProviderActionFuture<'_> {
        Box::pin(async { Err(AppError::conflict("当前没有等待回答的澄清请求")) })
    }
    fn reload(&self) -> ModelProviderActionFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn shutdown(&self) -> ModelProviderActionFuture<'_> {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Debug, Clone)]
pub struct ProjectChatInput {
    pub project: Project,
    pub messages: Vec<ProjectChatMessage>,
    pub reference_context: Option<String>,
    pub prompt_images: Vec<PromptImage>,
    pub model_settings: ModelSettings,
    pub pi_session_file: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProjectChatOutput {
    pub assistant_message: String,
    pub pi_session_file: Option<String>,
    pub trace: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct ProjectRequirementSummaryOutput {
    pub summary: ProjectRequirementSummary,
    pub pi_session_file: Option<String>,
    pub trace: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct RequirementAnalysisInput {
    pub project: Project,
    pub messages: Vec<RequirementMessage>,
    pub reference_context: Option<String>,
    pub prompt_images: Vec<PromptImage>,
    pub clarifications: Vec<RequirementClarification>,
    pub draft: Option<RequirementDraft>,
    pub model_settings: ModelSettings,
    pub pi_session_file: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RequirementAnalysisOutput {
    pub status: RequirementStatus,
    pub assistant_message: String,
    pub progress: String,
    pub clarifications: Vec<RequirementClarification>,
    pub draft: Option<RequirementDraft>,
    pub pi_session_file: Option<String>,
    pub error: Option<String>,
    pub trace: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct RequirementPlanInput {
    pub project: Project,
    pub requirement: Requirement,
    pub model_settings: ModelSettings,
}

#[derive(Debug, Clone)]
pub struct RequirementTaskExecutionInput {
    pub project: Project,
    pub requirement: Requirement,
    pub plan: RequirementExecutionPlan,
    pub task: RequirementExecutionTask,
    pub model_settings: ModelSettings,
}

#[derive(Debug, Clone)]
pub struct RequirementTaskExecutionOutput {
    pub result_summary: String,
    pub pi_session_file: Option<String>,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub review_status: Option<RequirementReviewStatus>,
    pub review_feedback: Option<String>,
    pub pull_request_url: Option<String>,
    pub merged_into: Option<String>,
    pub cleanup_summary: Option<String>,
    pub execution_warning: Option<String>,
    pub changed: Option<bool>,
    pub no_op_reason: Option<String>,
    pub recovery_guidance: Option<String>,
    pub trace: Option<Value>,
}

pub type RequirementEventBus = broadcast::Sender<RequirementEvent>;
pub type ProjectChatEventBus = broadcast::Sender<ProjectChatEvent>;

#[derive(Debug, Clone, Serialize)]
pub struct RequirementEvent {
    pub requirement_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub event: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pi_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectChatEvent {
    pub project_id: String,
    pub event: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pi_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct ProjectChatEventEmitter {
    pub project_id: String,
    pub bus: broadcast::Sender<ProjectChatEvent>,
}

impl ProjectChatEventEmitter {
    pub fn emit(&self, event: &str, message: &str) {
        let _ = self.bus.send(ProjectChatEvent {
            project_id: self.project_id.clone(),
            event: event.to_owned(),
            message: message.to_owned(),
            pi_type: None,
            payload: None,
        });
    }

    pub fn emit_pi_event(&self, payload: Value) {
        let pi_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let message = crate::pi_event::summarize_pi_event(&pi_type, &payload);
        let _ = self.bus.send(ProjectChatEvent {
            project_id: self.project_id.clone(),
            event: "pi_event".to_owned(),
            message,
            pi_type: Some(pi_type),
            payload: Some(payload),
        });
    }
}

#[derive(Debug, Clone)]
pub struct RequirementEventEmitter {
    pub requirement_id: String,
    pub task_id: Option<String>,
    pub bus: broadcast::Sender<RequirementEvent>,
}

impl RequirementEventEmitter {
    pub fn emit(&self, event: &str, message: &str) {
        let _ = self.bus.send(RequirementEvent {
            requirement_id: self.requirement_id.clone(),
            task_id: self.task_id.clone(),
            event: event.to_owned(),
            message: message.to_owned(),
            pi_type: None,
            payload: None,
        });
    }

    pub fn emit_pi_event(&self, payload: Value) {
        let pi_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let message = crate::pi_event::summarize_pi_event(&pi_type, &payload);
        let _ = self.bus.send(RequirementEvent {
            requirement_id: self.requirement_id.clone(),
            task_id: self.task_id.clone(),
            event: "pi_event".to_owned(),
            message,
            pi_type: Some(pi_type),
            payload: Some(payload),
        });
    }
}

// Request structs
#[derive(Debug, Deserialize)]
pub struct RequirementMessageRequest {
    pub message: String,
    #[serde(default)]
    pub references: Vec<FileReference>,
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
}

#[derive(Debug, Deserialize)]
pub struct ProjectChatMessageRequest {
    pub message: String,
    #[serde(default)]
    pub references: Vec<FileReference>,
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
}

#[derive(Debug, Deserialize)]
pub struct AttachmentUploadRequest {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClarificationAnswerRequest {
    pub clarification_id: String,
    pub selected_options: Vec<String>,
    pub custom_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ClarificationAnswerPayload {
    Legacy(Vec<ClarificationAnswerRequest>),
    Versioned {
        prompt_id: Option<String>,
        revision: Option<u32>,
        answers: Vec<ClarificationAnswerRequest>,
    },
}

impl ClarificationAnswerPayload {
    pub fn into_parts(self) -> (Option<String>, Option<u32>, Vec<ClarificationAnswerRequest>) {
        match self {
            Self::Legacy(answers) => (None, None, answers),
            Self::Versioned {
                prompt_id,
                revision,
                answers,
            } => (prompt_id, revision, answers),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RequirementConfirmRequest {
    pub prompt_id: Option<String>,
    pub revision: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_serializes_to_expected_fields() {
        let now = Utc::now();
        let project = Project {
            id: "p1".to_owned(),
            name: "Project".to_owned(),
            git_url: "https://example.com/repo.git".to_owned(),
            local_path: "/home/user/projects/p1/repo".to_owned(),
            created_at: now,
            updated_at: now,
        };
        let json = serde_json::to_value(&project).unwrap();
        assert_eq!(json["id"], "p1");
        assert_eq!(json["name"], "Project");
        assert_eq!(json["git_url"], "https://example.com/repo.git");
        assert_eq!(json["local_path"], "/home/user/projects/p1/repo");
    }

    #[test]
    fn requirement_skips_pi_session_file_in_serialization() {
        let now = Utc::now();
        let requirement = Requirement {
            id: "r1".to_owned(),
            project_id: "p1".to_owned(),
            title: "Title".to_owned(),
            original_message: "message".to_owned(),
            status: RequirementStatus::Clarifying,
            messages: Vec::new(),
            clarification_round: 0,
            clarifications: Vec::new(),
            draft: None,
            analysis_revision: 0,
            active_prompt: None,
            clarification_history: Vec::new(),
            execution_plan: None,
            pi_session_file: Some("/secret/session.json".to_owned()),
            error: None,
            queued_at: None,
            created_at: now,
            updated_at: now,
        };
        let json = serde_json::to_value(&requirement).unwrap();
        assert!(json.get("pi_session_file").is_none());
    }

    #[test]
    fn execution_task_without_review_history_remains_compatible() {
        let task: RequirementExecutionTask = serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "title": "实现",
            "description": "实现功能",
            "status": "pending",
            "result_summary": null,
            "error": null
        }))
        .unwrap();

        assert!(task.review_history.is_empty());
    }
}
