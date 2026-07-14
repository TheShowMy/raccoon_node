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
  name: string;
  git_url: string;
  local_path: string;
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
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type RequirementFailureStage =
  | "analysis"
  | "change_spec_validation"
  | "planning"
  | "plan_validation"
  | "persistence";

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

export type AcceptanceScenario = {
  id: string;
  given: string;
  when: string;
  then: string;
};

export type ExplicitConstraint = {
  id: string;
  statement: string;
  source_message_id: string;
  source_quote: string;
};

export type ChangeSpec = {
  intent: string;
  acceptance_scenarios: AcceptanceScenario[];
  explicit_constraints: ExplicitConstraint[];
  non_goals: string[];
};

export type WorkflowRunStatus =
  | "planning"
  | "running"
  | "validating"
  | "reviewing"
  | "fixing"
  | "rescuing"
  | "publishing"
  | "paused_technical"
  | "blocked"
  | "completed"
  | "cancelled";

export type WorkItemStatus =
  | "pending"
  | "running"
  | "accepted"
  | "blocked"
  | "cancelled";

export type ReviewAngle = "correctness" | "quality" | "security";

export type WorkflowAttemptKind =
  | "implementation"
  | "fix"
  | "integration_fix"
  | "remote_ci_fix"
  | "rescue";

export type WorkflowAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export type ValidationRunStatus =
  | "pending"
  | "passed"
  | "failed"
  | "unavailable";

export type FindingPriority = "P0" | "P1" | "P2" | "P3";

export type WorkflowPublicationMode = "local" | "pull_request";

export type WorkflowPublicationProvider = "local" | "github" | "gitlab";

export type WorkflowPublicationPhase =
  | "prepared"
  | "pushed"
  | "review_open"
  | "waiting_checks"
  | "merged"
  | "cleaning"
  | "completed";

export type WorkflowLocalSyncStatus = "pending" | "synced" | "skipped";

export type WorkflowCleanupStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type WorkflowRun = {
  id: string;
  requirement_id: string;
  status: WorkflowRunStatus;
  change_spec: ChangeSpec;
  design_notes: Array<{
    id: string;
    statement: string;
    evidence: string[];
    rationale: string;
  }>;
  plan_summary: string;
  source_revision: number;
  base_head?: string | null;
  integration_branch?: string | null;
  integration_worktree?: string | null;
  final_commit?: string | null;
  rescue_used: boolean;
  rescue_attempt_id?: string | null;
  blocked_reason?: string | null;
  paused_operation?: string | null;
  replaces_run_id?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

export type WorkItem = {
  id: string;
  run_id: string;
  position: number;
  objective: string;
  scenario_refs: string[];
  group?: string | null;
  scope_hints: string[];
  verification_goals: string[];
  status: WorkItemStatus;
  attempt_count: number;
  actual_attempt_count: number;
  accepted_attempt_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type OperationMetrics = {
  usage: TokenUsageCategory;
  scope: string;
  role?: string | null;
  context_percent: number;
  budget?: {
    limit: number;
    observed: number;
    ratio: number;
    exceeded: boolean;
    enforced: boolean;
  } | null;
  runtime?: {
    idle_timeout_seconds: number;
    max_idle_ms: number;
    activity_count: number;
    warning_count: number;
    termination_reason: string;
  } | null;
  compaction?: {
    count: number;
    completed: number;
    aborted: number;
    failed: number;
    overflow_retries: number;
    estimated_tokens_saved: number;
    usage_known: boolean;
  } | null;
  sources: Array<{
    kind: string;
    label: string;
    chars: number;
    estimated_tokens: number;
  }>;
};

export type ReviewReport = {
  selection: {
    classification: string;
    angles: ReviewAngle[];
    skipped_angles: ReviewAngle[];
    reasons: string[];
    focus: string;
    file_count: number;
    changed_lines: number;
    diff_bytes: number;
  };
  reviews: Array<{
    angle: ReviewAngle;
    transport_status: "completed" | "failed";
    context_mode?: string | null;
    context_hash?: string | null;
    context_bytes?: number | null;
    duration_ms: number;
    turns: number;
    submission_correction_count: number;
    retry_count: number;
    usage: TokenUsageCategory;
    runtime?: OperationMetrics["runtime"];
    error?: string | null;
  }>;
};

export type WorkflowAttempt = {
  id: string;
  run_id: string;
  work_item_id?: string | null;
  kind: WorkflowAttemptKind;
  ordinal: number;
  status: WorkflowAttemptStatus;
  model_tier: string;
  worktree_fingerprint?: string | null;
  result_summary?: string | null;
  failure_class?: string | null;
  failure_message?: string | null;
  usage?: OperationMetrics | null;
  started_at: string;
  completed_at?: string | null;
};

export type WorkflowCheckpoint = {
  id: string;
  run_id: string;
  kind: "final" | "rescue";
  revision: number;
  status:
    | "pending"
    | "reviewing"
    | "approved"
    | "rejected"
    | "technical_failure"
    | "cancelled";
  snapshot_sha: string;
  required_angles: ReviewAngle[];
  summary?: string | null;
  review_details?: ReviewReport | null;
  usage?: OperationMetrics | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

export type WorkflowFinding = {
  id: string;
  checkpoint_id: string;
  angle: ReviewAngle;
  priority: FindingPriority;
  status: "open" | "resolved";
  category: string;
  path?: string | null;
  location?: string | null;
  summary: string;
  evidence: string;
  reproduction?: string | null;
  remediation?: string | null;
  scenario_ref?: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkflowSnapshot = {
  run: WorkflowRun;
  work_items: WorkItem[];
  dependencies: Array<{ work_item_id: string; depends_on_id: string }>;
  attempts: WorkflowAttempt[];
  checkpoints: WorkflowCheckpoint[];
  validations: Array<{
    id: string;
    run_id: string;
    attempt_id?: string | null;
    checkpoint_id?: string | null;
    command: string;
    source: "repository_catalog" | "agent_observation";
    gating: boolean;
    baseline_status: ValidationRunStatus;
    final_status: ValidationRunStatus;
    baseline_exit_code?: number | null;
    final_exit_code?: number | null;
    output_summary?: string | null;
    worktree_fingerprint: string;
    created_at: string;
    completed_at?: string | null;
  }>;
  findings: WorkflowFinding[];
  publication?: {
    run_id: string;
    mode: WorkflowPublicationMode;
    provider: WorkflowPublicationProvider;
    phase: WorkflowPublicationPhase;
    origin: string;
    target_branch: string;
    source_branch: string;
    review_url?: string | null;
    head_commit?: string | null;
    merge_commit?: string | null;
    local_sync_status: WorkflowLocalSyncStatus;
    local_sync_message?: string | null;
    cleanup_status: WorkflowCleanupStatus;
    remote_ci_fix_used: boolean;
    last_error?: string | null;
    updated_at: string;
  } | null;
  item_workspaces?: Array<{
    work_item_id: string;
    run_id: string;
    branch: string;
    base_commit: string;
    result_commit?: string | null;
    status:
      | "prepared"
      | "running"
      | "committed"
      | "integrated"
      | "superseded"
      | "cleaned";
    fallback_serial: boolean;
    updated_at: string;
  }>;
  last_event_sequence: number;
};

export type WorkflowEvent = {
  sequence: number;
  run_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type WorkflowEventPage = {
  events: WorkflowEvent[];
  next_after: number | null;
};

export type ProjectFileContent = {
  path: string;
  content: string;
  truncated: boolean;
};

export type TerminalSessionStatus = "starting" | "running" | "exited";

export type TerminalSession = {
  id: string;
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

export type TerminalServerMessage =
  | { type: "output"; data: string }
  | {
      type: "status";
      status: TerminalSessionStatus;
      exit_code?: number | null;
    }
  | { type: "error"; message: string };

export type Requirement = {
  id: string;
  title: string;
  origin: "project_chat_branch" | "standalone";
  status: RequirementStatus;
  messages: RequirementMessage[];
  clarification_round: number;
  clarifications: RequirementClarification[];
  draft: ChangeSpec | null;
  error: string | null;
  failure_stage?: RequirementFailureStage | null;
  failure_code?: string | null;
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
      prompt_id: string;
      revision: number;
    }
  | {
      type: "confirmation";
      draft: ChangeSpec;
      prompt_id: string;
      revision: number;
    };

export type RequirementConversation = {
  id: string;
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
  workflow_runs?: WorkflowSnapshot[];
  token_usage?: ProjectTokenUsage | null;
};

export type TokenUsageCategory = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

export type ProjectTokenUsage = {
  chat: TokenUsageCategory;
  split: TokenUsageCategory;
  task: TokenUsageCategory;
  total: TokenUsageCategory;
  max_context_percent?: number;
  hotspots?: Array<{
    label: string;
    role: string;
    usage: TokenUsageCategory;
    context_percent: number;
    budget_exceeded?: boolean;
  }>;
  roles?: Array<{ role: string; usage: TokenUsageCategory }>;
  sources?: Array<{
    kind: string;
    label: string;
    chars: number;
    estimated_tokens: number;
  }>;
  compaction?: {
    count: number;
    completed: number;
    aborted: number;
    failed: number;
    overflow_retries: number;
    estimated_tokens_saved: number;
    usage_known: boolean;
  } | null;
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
  compaction?: TraceCompaction;
  budget?: TraceBudget;
  runtime?: TraceRuntime;
  parallelReviewSelection?: {
    classification: string;
    angles: string[];
    skippedAngles: string[];
    reasons: string[];
    focus: string;
    fileCount: number;
    changedLines: number;
    diffBytes: number;
  };
};

export type TraceBudget = {
  limit: number;
  observed: number;
  ratio: number;
  exceeded: boolean;
  enforced: false;
  warningEmitted: boolean;
};

export type TraceRuntime = {
  warningAfterSeconds: number;
  idleTimeoutSeconds: number;
  maxIdleMilliseconds: number;
  activityCount: number;
  idleWarningCount: number;
  terminationReason: string;
  absoluteTimeout: false;
};

export type TraceCompaction = {
  autoEnabled?: boolean;
  usageKnown: false;
  estimated: true;
  count: number;
  completed: number;
  aborted: number;
  failed: number;
  overflowRetries: number;
  estimatedTokensSaved: number;
  events: Array<{
    reason: "manual" | "threshold" | "overflow" | string;
    status: "running" | "completed" | "aborted" | "failed" | string;
    tokensBefore?: number;
    estimatedTokensAfter?: number;
    estimatedTokensSaved?: number;
    willRetry: boolean;
    usageKnown: false;
    error?: string;
  }>;
};

export type TraceUsage = {
  scope?: "operation" | "session";
  sessionReused: boolean;
  callCount: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  subagents?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    maxContextTokens: number;
    maxContextPercent: number;
  };
  context: {
    tokens: number;
    window: number;
    percent: number;
  };
};

export type TraceMetadata = {
  type: "pi_trace";
  trace: TraceData;
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
      kind: "requirement-list";
      pendingRequirements: Requirement[];
      completedRequirements: Requirement[];
      workflowRequirementIds: Set<string>;
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
      kind: "workflow-run";
      requirement: Requirement;
      workflowRun?: WorkflowSnapshot | null;
      actionError: string | null;
      onClose: () => void;
    }
  | {
      kind: "workflow-item";
      workflow: WorkflowSnapshot;
      item: WorkItem;
    };

export type RequirementNodeData =
  | Extract<StartNodeData, { kind: "requirement-list" }>
  | Extract<StartNodeData, { kind: "workflow-run" }>
  | Extract<StartNodeData, { kind: "workflow-item" }>;
