use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::{ChangeSpec, ModelSettings, Project, Requirement, RequirementModelTier};

static WORKFLOW_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub fn new_workflow_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        Utc::now().timestamp_millis(),
        WORKFLOW_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunStatus {
    Planning,
    Running,
    Validating,
    Reviewing,
    Fixing,
    Rescuing,
    Publishing,
    PausedTechnical,
    Completed,
    Blocked,
    Cancelled,
}

impl WorkflowRunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Blocked | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemStatus {
    Pending,
    Leased,
    Running,
    Ready,
    Accepted,
    Blocked,
    Cancelled,
}

impl WorkItemStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Accepted | Self::Blocked | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowAttemptKind {
    Implementation,
    Fix,
    IntegrationFix,
    RemoteCiFix,
    Rescue,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowAttemptStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Superseded,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowPublicationMode {
    Local,
    PullRequest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowPublicationProvider {
    Local,
    #[serde(rename = "github")]
    GitHub,
    #[serde(rename = "gitlab")]
    GitLab,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowPublicationPhase {
    Prepared,
    Pushed,
    ReviewOpen,
    WaitingChecks,
    Merged,
    Cleaning,
    Completed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowLocalSyncStatus {
    Pending,
    Synced,
    Skipped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowCleanupStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowItemWorkspaceStatus {
    Prepared,
    Running,
    Committed,
    Integrated,
    Superseded,
    Cleaned,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointKind {
    SecurityPrecheck,
    Final,
    Rescue,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointStatus {
    Pending,
    Reviewing,
    Approved,
    Rejected,
    TechnicalFailure,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ValidationSource {
    RepositoryCatalog,
    AgentObservation,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ValidationRunStatus {
    Pending,
    Passed,
    Failed,
    Unavailable,
    Skipped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAngle {
    Correctness,
    Quality,
    Security,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum FindingPriority {
    P0,
    P1,
    P2,
    P3,
}

impl FindingPriority {
    pub fn is_blocking(self) -> bool {
        matches!(self, Self::P0 | Self::P1)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingStatus {
    Open,
    Resolved,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    ModelProtocol,
    AgentRuntime,
    Validation,
    ReviewRejected,
    GitConflict,
    WorkspaceViolation,
    Infrastructure,
    BehaviourConflict,
    Cancelled,
}

impl FailureClass {
    pub fn is_technical(self) -> bool {
        matches!(
            self,
            Self::ModelProtocol
                | Self::AgentRuntime
                | Self::GitConflict
                | Self::WorkspaceViolation
                | Self::Infrastructure
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesignNote {
    pub id: String,
    pub statement: String,
    pub evidence: Vec<String>,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowRun {
    pub id: String,
    pub requirement_id: String,
    pub project_id: String,
    pub status: WorkflowRunStatus,
    pub change_spec: ChangeSpec,
    #[serde(default)]
    pub design_notes: Vec<DesignNote>,
    pub plan_summary: String,
    pub source_revision: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_commit: Option<String>,
    pub rescue_used: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rescue_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces_run_id: Option<String>,
    pub version: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkItem {
    pub id: String,
    pub run_id: String,
    pub position: u32,
    pub objective: String,
    pub scenario_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default)]
    pub scope_hints: Vec<String>,
    #[serde(default)]
    pub verification_goals: Vec<String>,
    pub status: WorkItemStatus,
    pub attempt_count: u32,
    #[serde(default)]
    pub actual_attempt_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub version: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkItemDependency {
    pub work_item_id: String,
    pub depends_on_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowAttempt {
    pub id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    pub kind: WorkflowAttemptKind,
    pub ordinal: u32,
    pub status: WorkflowAttemptStatus,
    pub model_tier: String,
    #[serde(default, skip_serializing)]
    pub pi_session_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_class: Option<FailureClass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowCheckpoint {
    pub id: String,
    pub run_id: String,
    pub kind: CheckpointKind,
    pub revision: u32,
    pub status: CheckpointStatus,
    pub snapshot_sha: String,
    pub required_angles: Vec<ReviewAngle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowValidation {
    pub id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
    pub command: String,
    pub source: ValidationSource,
    pub gating: bool,
    pub baseline_status: ValidationRunStatus,
    pub final_status: ValidationRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_summary: Option<String>,
    pub worktree_fingerprint: String,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowReviewFinding {
    pub id: String,
    pub checkpoint_id: String,
    pub angle: ReviewAngle,
    pub priority: FindingPriority,
    pub status: FindingStatus,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    pub summary: String,
    pub evidence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reproduction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_ref: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowPublication {
    pub run_id: String,
    pub mode: WorkflowPublicationMode,
    pub provider: WorkflowPublicationProvider,
    pub phase: WorkflowPublicationPhase,
    pub origin: String,
    pub target_branch: String,
    pub source_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_commit: Option<String>,
    pub local_sync_status: WorkflowLocalSyncStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_sync_message: Option<String>,
    pub cleanup_status: WorkflowCleanupStatus,
    pub remote_ci_fix_used: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowItemWorkspace {
    pub work_item_id: String,
    pub run_id: String,
    pub branch: String,
    #[serde(skip_serializing)]
    pub worktree_path: String,
    pub base_commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_commit: Option<String>,
    pub status: WorkflowItemWorkspaceStatus,
    pub fallback_serial: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedWorkflowWorkspace {
    pub run_id: String,
    pub worktree_path: String,
    pub branch: String,
    pub base_head: String,
    pub final_commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowEvent {
    pub sequence: i64,
    pub run_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub event_type: String,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowEventPage {
    pub events: Vec<WorkflowEvent>,
    pub next_after: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowSnapshot {
    pub run: WorkflowRun,
    pub work_items: Vec<WorkItem>,
    pub dependencies: Vec<WorkItemDependency>,
    pub attempts: Vec<WorkflowAttempt>,
    pub checkpoints: Vec<WorkflowCheckpoint>,
    pub validations: Vec<WorkflowValidation>,
    pub findings: Vec<WorkflowReviewFinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication: Option<WorkflowPublication>,
    #[serde(default)]
    pub item_workspaces: Vec<WorkflowItemWorkspace>,
    pub last_event_sequence: i64,
}

#[derive(Debug, Clone)]
pub struct WorkflowPlanInput {
    pub project: Project,
    pub requirement: Requirement,
    pub model_settings: ModelSettings,
}

#[derive(Debug, Clone)]
pub struct WorkflowPlanOutput {
    pub plan: super::WorkPlan,
    pub trace: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct WorkflowAgentInput {
    pub project: Project,
    pub run: WorkflowRun,
    pub work_item: Option<WorkItem>,
    pub attempt_kind: WorkflowAttemptKind,
    pub model_tier: RequirementModelTier,
    pub working_dir: std::path::PathBuf,
    pub open_blockers: Vec<WorkflowReviewFinding>,
    pub recent_failures: Vec<WorkflowAttempt>,
    pub validation_evidence: Vec<WorkflowValidation>,
    pub model_settings: ModelSettings,
    /// Resume an existing managed Pi session for a deliberately short follow-up turn.
    pub resume_session_file: Option<String>,
    pub continuation_feedback: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WorkflowAgentOutput {
    pub completed: bool,
    pub changed: bool,
    pub result_summary: String,
    pub pi_session_file: Option<String>,
    pub worktree_fingerprint: Option<String>,
    pub usage: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct WorkflowReviewInput {
    pub project: Project,
    pub run: WorkflowRun,
    pub checkpoint: WorkflowCheckpoint,
    pub working_dir: std::path::PathBuf,
    pub validation_evidence: Vec<WorkflowValidation>,
    pub prior_findings: Vec<WorkflowReviewFinding>,
    pub model_settings: ModelSettings,
}

#[derive(Debug, Clone)]
pub struct WorkflowReviewOutput {
    pub findings: Vec<WorkflowReviewFinding>,
    pub technical_failure: Option<String>,
    pub usage: Option<Value>,
    pub details: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct WorkflowRescueInput {
    pub project: Project,
    pub run: WorkflowRun,
    pub working_dir: std::path::PathBuf,
    pub open_blockers: Vec<WorkflowReviewFinding>,
    pub recent_failures: Vec<WorkflowAttempt>,
    pub validation_evidence: Vec<WorkflowValidation>,
    pub model_settings: ModelSettings,
}
