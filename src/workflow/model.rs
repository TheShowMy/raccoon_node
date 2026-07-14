use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::{
    ChangeSpec, ModelSettings, Project, PromptSourceUsage, Requirement, RequirementModelTier,
    TokenCompactionUsage, TokenUsageCategory,
};

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
    Running,
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAngle {
    Correctness,
    Quality,
    Security,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewTransportStatus {
    Completed,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewSelectionReport {
    pub classification: String,
    pub angles: Vec<ReviewAngle>,
    #[serde(default)]
    pub skipped_angles: Vec<ReviewAngle>,
    #[serde(default)]
    pub reasons: Vec<String>,
    pub focus: String,
    pub file_count: u64,
    pub changed_lines: u64,
    pub diff_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewSubagentReport {
    pub angle: ReviewAngle,
    pub transport_status: ReviewTransportStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_bytes: Option<u64>,
    pub duration_ms: u64,
    pub turns: u32,
    pub submission_correction_count: u32,
    pub retry_count: u32,
    pub usage: TokenUsageCategory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<OperationRuntimeMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ReviewReport {
    pub selection: ReviewSelectionReport,
    pub reviews: Vec<ReviewSubagentReport>,
}

impl ReviewReport {
    pub fn from_details(details: &Value) -> Result<Self, String> {
        let selection = details
            .get("selection")
            .ok_or_else(|| "审核 details 缺少 selection".to_owned())?;
        let parse_angles = |key: &str| -> Result<Vec<ReviewAngle>, String> {
            selection
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|value| {
                    value
                        .as_str()
                        .and_then(review_angle_from_text)
                        .ok_or_else(|| format!("审核 selection.{key} 包含未知角度"))
                })
                .collect()
        };
        let selection = ReviewSelectionReport {
            classification: bounded_text(selection.get("classification"), 80),
            angles: parse_angles("angles")?,
            skipped_angles: parse_angles("skippedAngles")?,
            reasons: selection
                .get("reasons")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(8)
                .map(|value| bounded_text(Some(value), 240))
                .collect(),
            focus: bounded_text(selection.get("focus"), 240),
            file_count: value_u64(selection, "fileCount"),
            changed_lines: value_u64(selection, "changedLines"),
            diff_bytes: value_u64(selection, "diffBytes"),
        };
        let reviews = details
            .get("reviews")
            .and_then(Value::as_array)
            .ok_or_else(|| "审核 details 缺少 reviews".to_owned())?
            .iter()
            .map(|review| {
                let angle = review
                    .get("angle")
                    .and_then(Value::as_str)
                    .and_then(review_angle_from_text)
                    .ok_or_else(|| "审核记录包含未知角度".to_owned())?;
                let transport_status = match review.get("transport_status").and_then(Value::as_str)
                {
                    Some("completed") => ReviewTransportStatus::Completed,
                    Some("failed") => ReviewTransportStatus::Failed,
                    _ => return Err("审核记录包含未知 transport_status".to_owned()),
                };
                Ok(ReviewSubagentReport {
                    angle,
                    transport_status,
                    context_mode: optional_bounded_text(review.get("context_mode"), 40),
                    context_hash: optional_bounded_text(review.get("context_hash"), 128),
                    context_bytes: review.get("context_bytes").and_then(Value::as_u64),
                    duration_ms: value_u64(review, "duration_ms"),
                    turns: u32::try_from(value_u64(review, "turns")).unwrap_or(u32::MAX),
                    submission_correction_count: u32::try_from(value_u64(
                        review,
                        "submission_correction_count",
                    ))
                    .unwrap_or(u32::MAX),
                    retry_count: u32::try_from(value_u64(review, "retry_count"))
                        .unwrap_or(u32::MAX),
                    usage: token_usage_from_value(review.get("usage")),
                    runtime: review.get("runtime").map(operation_runtime_from_value),
                    error: optional_bounded_text(review.get("error"), 480),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self { selection, reviews })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct OperationMetrics {
    pub usage: TokenUsageCategory,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub context_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<OperationBudgetMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<OperationRuntimeMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<TokenCompactionUsage>,
    #[serde(default)]
    pub sources: Vec<PromptSourceUsage>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct OperationBudgetMetrics {
    pub limit: u64,
    pub observed: u64,
    pub ratio: f64,
    pub exceeded: bool,
    pub enforced: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OperationRuntimeMetrics {
    pub idle_timeout_seconds: u64,
    pub max_idle_ms: u64,
    pub activity_count: u64,
    pub warning_count: u64,
    pub termination_reason: String,
}

impl OperationMetrics {
    pub fn from_trace(value: &Value) -> Option<Self> {
        let trace = value.get("trace")?;
        let raw_usage = trace.get("usage")?;
        let usage = TokenUsageCategory {
            input: value_u64(raw_usage, "input"),
            output: value_u64(raw_usage, "output"),
            cache_read: raw_usage
                .get("cacheRead")
                .or_else(|| raw_usage.get("cache_read"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            cache_write: raw_usage
                .get("cacheWrite")
                .or_else(|| raw_usage.get("cache_write"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
        };
        let budget = trace.get("budget").map(|value| OperationBudgetMetrics {
            limit: value_u64(value, "limit"),
            observed: value_u64(value, "observed"),
            ratio: value.get("ratio").and_then(Value::as_f64).unwrap_or(0.0),
            exceeded: value
                .get("exceeded")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            enforced: value
                .get("enforced")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
        let runtime = trace.get("runtime").map(operation_runtime_from_value);
        let compaction = trace.get("compaction").map(|value| TokenCompactionUsage {
            count: value_u64(value, "count"),
            completed: value_u64(value, "completed"),
            aborted: value_u64(value, "aborted"),
            failed: value_u64(value, "failed"),
            overflow_retries: value
                .get("overflowRetries")
                .or_else(|| value.get("overflow_retries"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            estimated_tokens_saved: value
                .get("estimatedTokensSaved")
                .or_else(|| value.get("estimated_tokens_saved"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            usage_known: value
                .get("usageKnown")
                .or_else(|| value.get("usage_known"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
        let sources = trace
            .pointer("/prompt/sources")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|source| source.get("included").and_then(Value::as_bool) == Some(true))
            .take(32)
            .map(|source| PromptSourceUsage {
                kind: bounded_text(source.get("kind"), 40),
                label: bounded_text(source.get("label"), 120),
                chars: value_u64(source, "chars"),
                estimated_tokens: value_u64(source, "estimated_tokens"),
            })
            .collect();
        Some(Self {
            usage,
            scope: raw_usage
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("operation")
                .to_owned(),
            role: optional_bounded_text(trace.pointer("/prompt/role"), 80),
            context_percent: raw_usage
                .pointer("/context/percent")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            budget,
            runtime,
            compaction,
            sources,
        })
    }
}

fn review_angle_from_text(value: &str) -> Option<ReviewAngle> {
    match value {
        "正确性" | "correctness" => Some(ReviewAngle::Correctness),
        "代码质量与测试" | "quality" => Some(ReviewAngle::Quality),
        "边界与安全" | "security" => Some(ReviewAngle::Security),
        _ => None,
    }
}

fn value_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn token_usage_from_value(value: Option<&Value>) -> TokenUsageCategory {
    let Some(value) = value else {
        return TokenUsageCategory::default();
    };
    TokenUsageCategory {
        input: value_u64(value, "input"),
        output: value_u64(value, "output"),
        cache_read: value
            .get("cacheRead")
            .or_else(|| value.get("cache_read"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_write: value
            .get("cacheWrite")
            .or_else(|| value.get("cache_write"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

fn operation_runtime_from_value(value: &Value) -> OperationRuntimeMetrics {
    OperationRuntimeMetrics {
        idle_timeout_seconds: value
            .get("idleTimeoutSeconds")
            .or_else(|| value.get("idle_timeout_seconds"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        max_idle_ms: value
            .get("maxIdleMs")
            .or_else(|| value.get("max_idle_ms"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        activity_count: value
            .get("activityCount")
            .or_else(|| value.get("activity_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        warning_count: value
            .get("idleWarningCount")
            .or_else(|| value.get("warningCount"))
            .or_else(|| value.get("warning_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        termination_reason: bounded_text(
            value
                .get("terminationReason")
                .or_else(|| value.get("termination_reason")),
            80,
        ),
    }
}

fn optional_bounded_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let value = value?.as_str()?;
    (!value.is_empty()).then(|| value.chars().take(max_chars).collect())
}

fn bounded_text(value: Option<&Value>, max_chars: usize) -> String {
    optional_bounded_text(value, max_chars).unwrap_or_default()
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
    pub paused_operation: Option<PausedOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces_run_id: Option<String>,
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

macro_rules! paused_operations {
    ($( $variant:ident => $value:literal ),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
        pub enum PausedOperation {
            $(#[serde(rename = $value)] $variant),+
        }

        impl PausedOperation {
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $value),+ }
            }
        }

        impl std::str::FromStr for PausedOperation {
            type Err = ();

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value { $($value => Ok(Self::$variant),)+ _ => Err(()) }
            }
        }
    };
}

paused_operations! {
    ProcessRestart => "process_restart",
    RestorePublicationWorkspace => "restore_publication_workspace",
    PrepareWorkspace => "prepare_workspace",
    AttachWorkspace => "attach_workspace",
    FreezePublication => "freeze_publication",
    LoadValidationScope => "load_validation_scope",
    DiscoverValidationCatalog => "discover_validation_catalog",
    ValidationBaseline => "validation_baseline",
    LoadSnapshot => "load_snapshot",
    WorkspaceViolation => "workspace_violation",
    PersistAttempt => "persist_attempt",
    ItemWorkspaceCleanup => "item_workspace_cleanup",
    CommitIntegration => "commit_integration",
    FastForwardIntegration => "fast_forward_integration",
    BeginPublication => "begin_publication",
    IntegrationFix => "integration_fix",
    FinalValidationOrReview => "final_validation_or_review",
    Review => "review",
    RescueSnapshot => "rescue_snapshot",
    StageBeforeRescue => "stage_before_rescue",
    SnapshotBeforeRescue => "snapshot_before_rescue",
    BeginRescue => "begin_rescue",
    RescueAgent => "rescue_agent",
    StageRescueChanges => "stage_rescue_changes",
    SnapshotAfterRescue => "snapshot_after_rescue",
    RescueCommit => "rescue_commit",
    RescueIntegration => "rescue_integration",
    PersistRescueCompletion => "persist_rescue_completion",
    BeginRescuePublication => "begin_rescue_publication",
    RescueValidationOrReview => "rescue_validation_or_review",
    ResumePublication => "resume_publication",
    LoadPublication => "load_publication",
    LocalIntegration => "local_integration",
    PersistLocalMerge => "persist_local_merge",
    PublicationReadiness => "publication_readiness",
    PublicationPush => "publication_push",
    PersistPublicationPush => "persist_publication_push",
    PublicationSnapshot => "publication_snapshot",
    PublicationOpenReview => "publication_open_review",
    PersistPublicationReview => "persist_publication_review",
    PublicationExternalAction => "publication_external_action",
    PublicationAutoMerge => "publication_auto_merge",
    PublicationPoll => "publication_poll",
    PersistPublicationWait => "persist_publication_wait",
    PersistRemoteMerge => "persist_remote_merge",
    PersistRemoteChecks => "persist_remote_checks",
    RemoteCiFailedAfterFix => "remote_ci_failed_after_fix",
    PersistRemoteCiFix => "persist_remote_ci_fix",
    RemoteCiFix => "remote_ci_fix",
    PersistLocalSync => "persist_local_sync",
    PersistCleanupStart => "persist_cleanup_start",
    PublicationCleanup => "publication_cleanup",
    PersistCleanupCompletion => "persist_cleanup_completion",
    PersistCompletion => "persist_completion",
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
    pub usage: Option<OperationMetrics>,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    pub review_details: Option<ReviewReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<OperationMetrics>,
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
    pub details: Option<ReviewReport>,
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
