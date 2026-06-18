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
    pub settings_summary: SummaryNode,
    pub model_summary: SummaryNode,
    #[serde(default)]
    pub model_settings: ModelSettings,
}

impl Default for AppData {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            requirements: Vec::new(),
            settings_summary: SummaryNode {
                title: "设置".to_owned(),
                description: "基础设置待配置".to_owned(),
            },
            model_summary: SummaryNode {
                title: "模型设置".to_owned(),
                description: "默认模型待配置".to_owned(),
            },
            model_settings: ModelSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub git_url: String,
    pub local_path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
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
    #[serde(skip_serializing)]
    pub pi_session_file: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    Analyzing,
    Clarifying,
    DraftReady,
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementMessage {
    pub role: RequirementMessageRole,
    pub content: String,
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
pub struct RequirementClarification {
    pub id: String,
    pub question: String,
    pub question_type: ClarificationQuestionType,
    pub options: Vec<ClarificationOption>,
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
    Error,
}

pub type ModelProviderFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<PiModel>, AppError>> + Send + 'a>>;
pub type RequirementAnalysisFuture<'a> =
    Pin<Box<dyn Future<Output = Result<RequirementAnalysisOutput, AppError>> + Send + 'a>>;

pub trait ModelProvider: Send + Sync {
    fn available_models(&self) -> ModelProviderFuture<'_>;
    fn analyze_requirement(
        &self,
        input: RequirementAnalysisInput,
        events: Option<RequirementEventEmitter>,
    ) -> RequirementAnalysisFuture<'_>;
}

#[derive(Debug, Clone)]
pub struct RequirementAnalysisInput {
    pub project: Project,
    pub messages: Vec<RequirementMessage>,
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
pub struct RequirementEventBus {
    pub tx: broadcast::Sender<RequirementEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RequirementEvent {
    pub requirement_id: String,
    pub event: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pi_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct RequirementEventEmitter {
    pub requirement_id: String,
    pub bus: RequirementEventBus,
}

impl RequirementEventEmitter {
    pub fn emit(&self, event: &str, message: &str) {
        let _ = self.bus.tx.send(RequirementEvent {
            requirement_id: self.requirement_id.clone(),
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
        let message = crate::requirement_analysis::summarize_pi_event(&pi_type, &payload);
        let _ = self.bus.tx.send(RequirementEvent {
            requirement_id: self.requirement_id.clone(),
            event: "pi_event".to_owned(),
            message,
            pi_type: Some(pi_type),
            payload: Some(payload),
        });
    }
}

// Raw deserialization structs for requirement analysis
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementAnalysisStatus {
    NeedsClarification,
    Ready,
}

#[derive(Debug, Deserialize)]
pub struct RawRequirementAnalysisJson {
    pub status: RequirementAnalysisStatus,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub progress: String,
    #[serde(default)]
    pub clarifications: Vec<RawRequirementClarification>,
    pub draft: Option<RequirementDraft>,
}

#[derive(Debug, Deserialize)]
pub struct RawRequirementClarification {
    pub id: Option<String>,
    pub question: String,
    #[serde(alias = "questionType", alias = "type")]
    pub question_type: Option<ClarificationQuestionType>,
    #[serde(default)]
    pub options: Vec<RawClarificationOption>,
}

#[derive(Debug, Deserialize)]
pub struct RawClarificationOption {
    pub value: Option<String>,
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub recommended: bool,
}

// Request structs
#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub git_url: String,
}

#[derive(Debug, Deserialize)]
pub struct RequirementMessageRequest {
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClarificationAnswerRequest {
    pub clarification_id: String,
    pub selected_options: Vec<String>,
    pub custom_text: Option<String>,
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
            local_path: "/data/projects/p1/repo".to_owned(),
            created_at: now,
            updated_at: now,
        };
        let json = serde_json::to_value(&project).unwrap();
        assert_eq!(json["id"], "p1");
        assert_eq!(json["name"], "Project");
        assert_eq!(json["git_url"], "https://example.com/repo.git");
        assert_eq!(json["local_path"], "/data/projects/p1/repo");
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
            pi_session_file: Some("/secret/session.json".to_owned()),
            error: None,
            created_at: now,
            updated_at: now,
        };
        let json = serde_json::to_value(&requirement).unwrap();
        assert!(json.get("pi_session_file").is_none());
    }
}
