// WARNING: These types must stay in sync with src/models.rs.
// When modifying Rust types, update this file and run `cargo test`.

export type ThemePack =
  | "neutral"
  | "stone"
  | "matcha"
  | "y2k"
  | "chocolate"
  | "gothic"
  | "butter";
export type ThemeMode = "dark" | "light";

export type CommitMode = "local" | "pull_request";

export type BasicSettings = {
  theme_pack: ThemePack;
  theme_mode: ThemeMode;
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
  theme_pack?: ThemePack;
  theme_mode?: ThemeMode;
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

export type GitExpansionPhase = "collapsed" | "expanded";

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

export type SessionTranscriptPage = {
  entries: SessionEntry[];
  next_before: number | null;
  invalid_lines: number;
};

export type SessionEntry = {
  cursor: number;
  source: string;
  line: number;
  kind: string;
  id: string | null;
  role: string | null;
  timestamp: string | null;
  blocks: SessionContentBlock[];
  raw: unknown;
};

export type SessionContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "tool_result";
      tool_call_id: string;
      name: string;
      output: string;
      diff: string | null;
      is_error: boolean;
    }
  | { type: "unknown"; block_type: string; raw: unknown };

export type ProjectFileContent = {
  path: string;
  content: string;
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

export type TerminalAccessStatus = {
  required: boolean;
  authorized: boolean;
  expires_at: string | null;
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
  origin: "project_chat_branch" | "standalone";
  status: RequirementStatus;
  messages: RequirementMessage[];
  clarification_round: number;
  clarifications: RequirementClarification[];
  draft: RequirementDraft | null;
  execution_plan: RequirementExecutionPlan | null;
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

export type RequirementTimelineBranch = {
  requirementId: string;
  requirement: Requirement | null;
  conversation: RequirementConversation | null;
  loading: boolean;
  error: string | null;
  createdAt: string;
  opening: boolean;
};

export type ChatSubmission = {
  message: string;
  references: FileReference[];
  images: ImageAttachment[];
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

export type ProjectFileTreeEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
};

export type ConversationEventType =
  | "agent.event"
  | "snapshot.changed"
  | "session.error"
  | "notice.append";

export type ConversationEvent = {
  type: ConversationEventType;
  payload: Record<string, unknown>;
};

export type ProjectChatEvent = {
  project_id: string;
  event: string;
  message: string;
  pi_type?: string;
  payload?: unknown;
};

export type ChatAccepted = {
  accepted: true;
  turn_id: string;
};

export type RequirementAccepted = {
  accepted: true;
  requirement_id: string;
  origin?: "project_chat_branch" | "standalone";
  turn_id?: string;
};

export type AcceptedOperation = {
  accepted: true;
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
  input?: unknown;
  isError?: boolean;
};

export type TraceBlock =
  | {
      id: string;
      type: "thinking";
      content: string;
      status: "running" | "done" | "error" | string;
    }
  | {
      id: string;
      type: "tool";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      output: string;
      status: "running" | "done" | "error" | string;
      isError?: boolean;
    };

export type TraceData = {
  blocks?: TraceBlock[];
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
  preview?: string;
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
      terminalAccessRequired: boolean;
      terminalAccessAuthorized: boolean;
      terminalAccessBusy: boolean;
      terminalAccessError: string | null;
      piLoginSession: TerminalSession | null;
      piLoginBusy: boolean;
      piLoginError: string | null;
      needsModelOnboarding: boolean;
      modelDraftComplete: boolean;
      modelSavedComplete: boolean;
      onToggleExpanded: () => void;
      onOpenBasic: () => void;
      onOpenModels: () => void;
      onBasicChange: (settings: BasicSettings) => void;
      onThemeChange: (
        update: Pick<BasicSettingsUpdate, "theme_pack" | "theme_mode">,
      ) => Promise<void>;
      onSaveBasic: (
        confirmedExternal?: boolean,
      ) => Promise<BasicSettings | null>;
      onModelChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
      onSaveModels: () => Promise<void>;
      onReloadModels: () => Promise<void>;
      onAuthorizeTerminalAccess: (key: string) => Promise<boolean>;
      onStartPiLogin: () => Promise<void>;
      onClosePiLogin: () => Promise<void>;
    }
  | {
      kind: "requirement-list";
      pendingRequirements: Requirement[];
      completedRequirements: Requirement[];
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
      requirementTimeline: RequirementTimelineBranch[];
      hasOlderRequirementHistory: boolean;
      promptDismissed: boolean;
      busy: boolean;
      requirementOpeningId: string | null;
      error: string | null;
      streamEvents: StreamEvent[];
      projectChat: ProjectChatResponse | null;
      projectChatBusy: boolean;
      projectChatError: string | null;
      projectChatEvents: ConversationEvent[];
      onSend: (payload: ChatSubmission) => Promise<boolean>;
      onStartRequirement: (
        description: string,
        attachments: {
          references: FileReference[];
          images: ImageAttachment[];
        },
      ) => Promise<boolean>;
      onProjectChatSend: (payload: ChatSubmission) => Promise<boolean>;
      onProjectChatAbort: () => Promise<void>;
      onProjectChatReset: () => Promise<boolean>;
      onOpenRequirement?: (requirementId: string) => void;
      onLoadOlderRequirementHistory: () => Promise<boolean>;
      onSubmitClarifications: (
        requirement: Requirement,
        answers: Record<string, DraftClarificationAnswer>,
      ) => Promise<boolean>;
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
      terminalAccessRequired: boolean;
      terminalAccessAuthorized: boolean;
      terminalAccessExpiresAt: string | null;
      terminalAccessBusy: boolean;
      terminalAccessError: string | null;
      onToggleCollapsed: () => void;
      onAuthorizeTerminalAccess: (key: string) => Promise<boolean>;
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
      expanded: boolean;
      onToggleExpanded: () => void;
    };
