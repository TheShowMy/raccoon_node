// WARNING: These types must stay in sync with src/models.rs.
// When modifying Rust types, update this file and run `cargo test`.

export type ThemeMode = "dark" | "light";

export type CommitMode = "local" | "pull_request";

export type BasicSettings = {
  theme: ThemeMode;
  host: string;
  port: number;
  host_overridden: boolean;
  port_overridden: boolean;
  effective_host: string;
  effective_port: number;
  restart_required: boolean;
  commit_mode: CommitMode;
};

export type BasicSettingsUpdate = {
  theme?: ThemeMode;
  host?: string;
  port?: number;
  commit_mode?: CommitMode;
  confirmed_external?: boolean;
};

export type SettingsPage = "basic" | "models";

export type RestartResponse = {
  accepted: boolean;
  next_url: string;
};

export type Project = {
  id: string;
  name: string;
  git_url: string;
  local_path: string;
  created_at: string;
  updated_at: string;
};

export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "untracked"
  | "conflicted";

export type GitFileStatus = {
  path: string;
  original_path: string | null;
  staged: GitChangeKind | null;
  unstaged: GitChangeKind | null;
};

export type GitStatus = {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  branches: string[];
  remote_configured: boolean;
  write_blocked: boolean;
  blocked_reason: string | null;
  files: GitFileStatus[];
};

export type GitDiffArea = "staged" | "unstaged";

export type GitDiff = {
  path: string;
  area: GitDiffArea;
  content: string;
  binary: boolean;
  truncated: boolean;
};

export type GitAction =
  | { type: "stage"; paths: string[] }
  | { type: "unstage"; paths: string[] }
  | { type: "commit"; message: string; confirmed: boolean }
  | { type: "fetch" }
  | { type: "pull" }
  | { type: "push"; confirmed: boolean }
  | { type: "switch_branch"; branch: string }
  | { type: "create_branch"; branch: string };

export type GitExpansionPhase = "collapsed" | "vertical" | "expanded";

export type PublicationReadiness = {
  mode: "local" | "pull_request";
  ready: boolean;
  summary: string;
  issues: string[];
  notes: string[];
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
  references?: FileReference[];
  images?: ImageAttachment[];
  metadata?: TraceMetadata | null;
  created_at: string;
};

export type FileReference = {
  path: string;
};

export type ImageAttachment = {
  name: string;
  path: string;
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

export type RequirementReviewHistoryStep = {
  task_id: string;
  angle: string;
  status: RequirementReviewStatus;
  summary: string;
  failure_reason: string | null;
  completed_at: string;
};

export type RequirementReviewHistoryRound = {
  round: number;
  implementation_attempt: number;
  implementation_summary: string;
  status: "reviewing" | "approved" | "rejected";
  started_at: string;
  completed_at: string | null;
  reviews: RequirementReviewHistoryStep[];
  summary: string | null;
  summary_conclusion: RequirementReviewStatus | null;
  failure_reason: string | null;
};

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
  review_history: RequirementReviewHistoryRound[];
};

export type RequirementExecutionPlan = {
  summary: string;
  tasks: RequirementExecutionTask[];
};

export type RequirementTaskDetail = {
  task: RequirementExecutionTask;
  reviews: RequirementExecutionTask[];
  dependencies: RequirementExecutionTask[];
};

export type RequirementTaskSessionMessage = {
  id: string;
  role: string;
  text: string;
  thinking?: string;
  tools: RequirementTaskSessionTool[];
  timestamp: string;
};

export type RequirementTaskSessionTool = {
  id: string;
  name: string;
  arguments: unknown;
  output: string;
  diff?: string;
  is_error: boolean;
};

export type RequirementTaskSession = {
  messages: RequirementTaskSessionMessage[];
  truncated: boolean;
};

export type TerminalSessionStatus = "starting" | "running" | "exited";

export type TerminalSession = {
  id: string;
  project_id: string;
  title: string;
  command: string | null;
  status: TerminalSessionStatus;
  exit_code: number | null;
  created_at: string;
  updated_at: string;
};

export type TerminalCommandProfile = {
  id: string;
  name: string;
  command: string;
  created_at: string;
  updated_at: string;
};

export type TerminalCommandProfileDraft = {
  id?: string;
  name: string;
  command: string;
};

export type TerminalServerMessage =
  | { type: "output"; data: string }
  | {
      type: "status";
      status: TerminalSessionStatus;
      exit_code?: number | null;
    }
  | { type: "error"; message: string };

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" };

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
  queued_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type RequirementConversationItem =
  | {
      kind: "user";
      id: string;
      text: string;
      references?: FileReference[];
      images?: ImageAttachment[];
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
      prompt_id?: string;
      revision?: number;
    }
  | {
      type: "confirmation";
      draft: RequirementDraft;
      prompt_id?: string;
      revision?: number;
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
  token_usage?: ProjectTokenUsage | null;
};

export type ProjectTokenUsage = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  context_tokens: number;
  context_window: number;
  context_percent: number;
};

export type ProjectChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  references?: FileReference[];
  images?: ImageAttachment[];
  metadata?: TraceMetadata | null;
  created_at: string;
};

export type ProjectChatResponse = {
  project_id: string;
  messages: ProjectChatMessage[];
  running: boolean;
  error: string | null;
  updated_at: string;
};

export type ProjectChatEvent = {
  project_id: string;
  event: string;
  message: string;
  pi_type?: string;
  payload?: unknown;
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
      kind: "project-settings";
      expanded: boolean;
      page: SettingsPage;
      basicSettings: BasicSettings | null;
      basicError: string | null;
      savingBasic: boolean;
      savingTheme: boolean;
      modelSettings: ModelSettings;
      models: PiModel[];
      modelRpcStatus: "idle" | "loading" | "ready" | "reconnecting" | "error";
      modelError: string | null;
      savingModels: boolean;
      terminalDisabled: boolean;
      onToggleExpanded: () => void;
      onOpenBasic: () => void;
      onOpenModels: () => void;
      onBasicChange: (settings: BasicSettings) => void;
      onThemeChange: (theme: ThemeMode) => Promise<void>;
      onSaveBasic: (
        confirmedExternal?: boolean,
      ) => Promise<BasicSettings | null>;
      onModelChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
      onSaveModels: () => Promise<void>;
      onReloadModels: () => Promise<void>;
      onOpenLogin: () => void;
    }
  | {
      kind: "project-github";
      project: Project;
      publicationReadiness: PublicationReadiness;
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
      references?: FileReference[];
      images?: ImageAttachment[];
      busy: boolean;
      error: string | null;
      streamEvents: StreamEvent[];
      projectChat: ProjectChatResponse | null;
      projectChatInput: string;
      projectChatReferences?: FileReference[];
      projectChatImages?: ImageAttachment[];
      projectChatBusy: boolean;
      projectChatError: string | null;
      projectChatEvents: ProjectChatEvent[];
      answers: Record<string, DraftClarificationAnswer>;
      onInputChange: (value: string) => void;
      onReferencesChange?: (references: FileReference[]) => void;
      onImagesChange?: (images: ImageAttachment[]) => void;
      onSend: () => Promise<void>;
      onProjectChatInputChange: (value: string) => void;
      onProjectChatReferencesChange?: (references: FileReference[]) => void;
      onProjectChatImagesChange?: (images: ImageAttachment[]) => void;
      onProjectChatSend: () => Promise<void>;
      onProjectChatReset: () => Promise<void>;
      onAnswerChange: (
        clarification: RequirementClarification,
        answer: DraftClarificationAnswer,
      ) => void;
      onSubmitClarifications: (requirement: Requirement) => Promise<void>;
      onConfirm: (requirement: Requirement) => Promise<void>;
      onRetryAnalysis?: (requirement: Requirement) => Promise<void>;
      onContinueEditing: (requirement: Requirement) => void;
      onCancel: () => void;
      onAbandon: () => void;
    }
  | {
      kind: "project-terminal";
      project: Project;
      collapsed: boolean;
      sessions: TerminalSession[];
      activeSessionId: string | null;
      commandProfiles: TerminalCommandProfile[];
      busy: boolean;
      error: string | null;
      terminalDisabled: boolean;
      terminalDisabledReason?: string;
      onToggleCollapsed: () => void;
      onCreateTerminal: (
        command?: string | null,
        title?: string | null,
      ) => Promise<void>;
      onCloseTerminal: (terminalId: string) => Promise<void>;
      onSelectTerminal: (terminalId: string) => void;
      onSaveCommandProfiles: (
        profiles: TerminalCommandProfileDraft[],
      ) => Promise<void>;
    }
  | {
      kind: "project-git";
      phase: GitExpansionPhase;
      status: GitStatus | null;
      diff: GitDiff | null;
      selectedPaths: Set<string>;
      selectedDiff: { path: string; area: GitDiffArea } | null;
      busy: boolean;
      error: string | null;
      lastResult: string | null;
      onToggleExpanded: () => void;
      onRefresh: () => Promise<void>;
      onTogglePath: (path: string) => void;
      onSelectDiff: (path: string, area: GitDiffArea) => Promise<void>;
      onAction: (action: GitAction, result: string) => Promise<boolean>;
    }
  | {
      kind: "requirement-dag";
      requirement: Requirement;
      actionError: string | null;
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
      dependencies: RequirementExecutionTask[];
      busy: boolean;
      collapsed?: boolean;
      onToggleCollapsed?: (requirementId: string, taskId: string) => void;
      onRecoverTaskGroup: (
        requirementId: string,
        taskId: string,
      ) => Promise<void>;
    }
  | {
      kind: "token-usage";
      usage: ProjectTokenUsage | null;
    };
