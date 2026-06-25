// WARNING: These types must stay in sync with src/models.rs.
// When modifying Rust types, update this file and run `cargo test`.

export type ThemeMode = "dark" | "light";

export type Project = {
  id: string;
  name: string;
  git_url: string;
  local_path: string;
  created_at: string;
  updated_at: string;
};

export type SummaryNode = {
  title: string;
  description: string;
};

export type StartData = {
  projects: Project[];
  settings_summary: SummaryNode;
  model_summary: SummaryNode;
  model_settings: ModelSettings;
};

export type RequirementStatus =
  | "analyzing"
  | "clarifying"
  | "draft_ready"
  | "planning"
  | "plan_ready"
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type RequirementMessage = {
  role: "user" | "assistant" | "system" | "trace";
  content: string;
  metadata?: TraceMetadata | null;
  created_at: string;
};

export type RequirementDraft = {
  title: string;
  summary: string;
  acceptance_criteria: string[];
};

export type RequirementTaskStatus =
  | "pending"
  | "running"
  | "awaiting_review"
  | "fixing"
  | "completed"
  | "failed"
  | "skipped"
  | "approved"
  | "rejected";

export type RequirementTaskKind =
  | "implementation"
  | "review"
  | "review_summary"
  | "review_sub_agent"
  | "branch_merge"
  | "merge_review";

export type RequirementReviewStatus = "pending" | "approved" | "rejected";

export type RequirementRecoveryStage =
  | "none"
  | "auto_retry"
  | "guided_retry"
  | "high_tier_execution"
  | "exhausted";

export type RequirementExecutionTask = {
  id: string;
  title: string;
  description: string;
  depends_on: string[];
  kind: RequirementTaskKind;
  model_tier: ModelTierKey;
  timeout_seconds: number;
  pi_session_file: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  commit_sha: string | null;
  review_for: string | null;
  review_angle: string | null;
  review_status: RequirementReviewStatus;
  attempt: number;
  execution_failure_count: number;
  review_rejection_count: number;
  recovery_stage: RequirementRecoveryStage;
  failure_summary: string | null;
  recovery_guidance: string | null;
  high_tier_execution_used: boolean;
  last_review_feedback: string | null;
  pull_request_url: string | null;
  merged_into: string | null;
  cleanup_summary: string | null;
  execution_warning: string | null;
  trace: TraceMetadata | null;
  status: RequirementTaskStatus;
  target_files: string[];
  result_summary: string | null;
  error: string | null;
};

export type RequirementExecutionPlan = {
  summary: string;
  tasks: RequirementExecutionTask[];
};

export type Requirement = {
  id: string;
  project_id: string;
  title: string;
  original_message: string;
  status: RequirementStatus;
  messages: RequirementMessage[];
  clarification_round: number;
  clarifications: RequirementClarification[];
  draft: RequirementDraft | null;
  execution_plan: RequirementExecutionPlan | null;
  pi_session_file: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type RequirementConversationItem =
  | {
      kind: "user";
      id: string;
      text: string;
      created_at: string;
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      created_at: string;
    }
  | {
      kind: "notice";
      id: string;
      level: "info" | "warn";
      text: string;
      created_at: string;
    }
  | {
      kind: "process";
      id: string;
      title: string;
      status: "running" | "done" | "error";
      metadata: TraceMetadata | null;
      created_at: string;
    };

export type RequirementConversationPrompt =
  | {
      type: "clarification";
      round: number;
      questions: RequirementClarification[];
    }
  | {
      type: "confirmation";
      draft: RequirementDraft;
    };

export type RequirementConversation = {
  id: string;
  project_id: string;
  title: string;
  status: RequirementStatus;
  running: boolean;
  items: RequirementConversationItem[];
  prompt: RequirementConversationPrompt | null;
  error: string | null;
  updated_at: string;
};

export type ProjectCanvasData = {
  project: Project;
  active_requirement: Requirement | null;
  queued_requirements: Requirement[];
  completed_requirements: Requirement[];
};

export type ClarificationQuestionType =
  | "single_choice"
  | "multi_choice"
  | "free_text";

export type ClarificationOption = {
  value: string;
  label: string;
  description: string;
  recommended: boolean;
};

export type ClarificationAnswer = {
  selected_options: string[];
  custom_text: string | null;
};

export type RequirementClarification = {
  id: string;
  question: string;
  question_type: ClarificationQuestionType;
  options: ClarificationOption[];
  answer: ClarificationAnswer | null;
};

export type DraftClarificationAnswer = {
  selectedOptions: string[];
  customText: string;
};

export type StreamEvent = {
  requirement_id: string;
  task_id?: string;
  event: string;
  message: string;
  pi_type?: string;
  payload?: unknown;
};

export type TraceTool = {
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error" | string;
  output: string;
  isError?: boolean;
};

export type TraceData = {
  thinking: string;
  output: string;
  tools: TraceTool[];
  statuses: Array<{ type: string; message: string }>;
  usage?: TraceUsage;
};

export type TraceUsage = {
  sessionReused: boolean;
  callCount: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  context: {
    tokens: number;
    window: number;
    percent: number;
  };
};

export type TraceMetadata = {
  type: "pi_trace";
  version: number;
  trace: TraceData;
};

export type LiveBubble = {
  id: string;
  type: "thinking" | "tool" | "output" | "status";
  label: string;
  content: string;
  toolName?: string;
  status: "running" | "done" | "error";
};

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type ModelTierKey = "low" | "medium" | "high";

export type ModelTierSetting = {
  model_id: string | null;
  thinking_level: ThinkingLevel;
};

export type ModelSettings = Record<ModelTierKey, ModelTierSetting>;

export type PiModel = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
};

export type ModelSettingsResponse = {
  models: PiModel[];
  settings: ModelSettings;
  rpc_status: "ready" | "reconnecting" | "error";
  rpc_error: string | null;
};

export type StartNodeData =
  | {
      kind: "create";
      onCreate: (name: string, gitUrl: string) => Promise<void>;
      busy: boolean;
      error: string | null;
    }
  | {
      kind: "projects";
      projectCount: number;
    }
  | {
      kind: "project-item";
      project: Project;
      deletingId: string | null;
      pendingDeleteProjectId: string | null;
      onOpenProject: (project: Project) => void;
      onDeleteRequest: (project: Project) => void;
    }
  | {
      kind: "delete-confirm";
      project: Project;
      deleting: boolean;
      error: string | null;
      onCancel: () => void;
      onConfirm: (project: Project) => Promise<void>;
    }
  | {
      kind: "model-config";
      settings: ModelSettings;
      models: PiModel[];
      rpcStatus: "idle" | "loading" | "ready" | "reconnecting" | "error";
      error: string | null;
      saving: boolean;
      onChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
      onClose: () => void;
      onSave: () => Promise<void>;
    }
  | {
      kind: "style-settings";
      theme: ThemeMode;
      onThemeChange: (theme: ThemeMode) => void;
    }
  | {
      kind: "summary";
      title: string;
      description: string;
      icon: "model";
      actionLabel?: string;
      onAction?: () => void;
    }
  | {
      kind: "project-back";
      project: Project;
      onBack: () => void;
    }
  | {
      kind: "project-github";
      project: Project;
    }
  | {
      kind: "requirement-list";
      title: string;
      description: string;
      requirements: Requirement[];
      emptyText: string;
      tone: "done" | "pending";
      selectedRequirementId: string | null;
      busyRequirementId: string | null;
      onSelectRequirement: (requirement: Requirement) => void;
      onPlanRequirement: (requirement: Requirement) => Promise<void>;
    }
  | {
      kind: "requirement-chat";
      project: Project;
      requirement: Requirement | null;
      conversation: RequirementConversation | null;
      promptDismissed: boolean;
      input: string;
      busy: boolean;
      error: string | null;
      streamEvents: StreamEvent[];
      answers: Record<string, DraftClarificationAnswer>;
      onInputChange: (value: string) => void;
      onSend: () => Promise<void>;
      onAnswerChange: (
        clarification: RequirementClarification,
        answer: DraftClarificationAnswer,
      ) => void;
      onSubmitClarifications: (requirement: Requirement) => Promise<void>;
      onConfirm: (requirement: Requirement) => Promise<void>;
      onContinueEditing: (requirement: Requirement) => void;
      onCancel: () => void;
    }
  | {
      kind: "requirement-dag";
      requirement: Requirement;
      busy: boolean;
      actionError: string | null;
      onStartExecution: (requirement: Requirement) => Promise<void>;
      onClose: () => void;
    }
  | {
      kind: "requirement-task";
      nodeRole?:
        | "group"
        | "code"
        | "review_summary"
        | "review_sub_agent"
        | "external";
      requirementId: string;
      task: RequirementExecutionTask;
      reviews: RequirementExecutionTask[];
      streamEvents: StreamEvent[];
      busy: boolean;
      collapsed?: boolean;
      onToggleCollapsed?: (requirementId: string, taskId: string) => void;
      onRetryFailedNode: (
        requirementId: string,
        taskId: string,
      ) => Promise<void>;
      onRetryFromNode: (requirementId: string, taskId: string) => Promise<void>;
      onRerunReview: (requirementId: string, taskId: string) => Promise<void>;
    };
