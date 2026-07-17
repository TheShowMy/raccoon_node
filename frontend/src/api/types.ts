/**
 * 公共领域契约类型（03 文档 §5、01 文档 §8 的手写 TS 版）。
 * 后端阶段由 Rust OpenAPI / JSON Schema 生成产物替换并对账，业务组件只依赖本文件。
 */

export type IntentMode = "auto" | "question" | "change";
export type DetectedIntent = "question" | "change" | "ambiguous";

export type ConversationNodeKind =
  | "user_message"
  | "process"
  | "tool"
  | "assistant_answer"
  | "clarification_question"
  | "clarification_answer"
  | "requirement_spec"
  | "requirement_confirmation";

export type ConversationNodeState =
  "streaming" | "running" | "completed" | "failed" | "aborted";

export type RequirementState =
  | "drafting"
  | "clarifying"
  | "spec_ready"
  | "confirmed"
  | "queued"
  | "cancelled"
  | "superseded";

export type NotificationSeverity =
  "error" | "action_required" | "warning" | "success" | "info";

export type NotificationLifecycle = "active" | "acknowledged" | "resolved";

export type WorkbenchKind =
  "delivery" | "files" | "git" | "terminal" | "models" | "settings";

export type NotificationSourceWorkbench =
  WorkbenchKind | "conversation" | "system";

export type ToolActivityState = "waiting" | "running" | "completed" | "failed";

export type ToolActivity = {
  name: string;
  purpose: string;
  state: ToolActivityState;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  /** 截断摘要；完整输出经详情节点 / artifact 引用（FE-CHAT-009） */
  summary: string | null;
};

export type ConversationNode = {
  id: string;
  /** 单项目唯一 project graph，当前固定单值（03 §5） */
  graph_id: string;
  kind: ConversationNodeKind;
  state: ConversationNodeState;
  content: string;
  /** 节点内增量序号：node.delta 按 node_id + node_sequence 有序追加（PRD-CHAT-008） */
  node_sequence: number;
  intent: DetectedIntent | null;
  parent_ids: string[];
  branch_ids: string[];
  created_at: string;
  completed_at: string | null;
  requirement_id: string | null;
  requirement_revision: number | null;
  tool_activity: ToolActivity | null;
};

export type ConversationBranch = {
  id: string;
  graph_id: string;
  /** 分支锚点：历史用户节点（根分支为 null） */
  anchor_node_id: string | null;
  parent_branch_id: string | null;
  created_at: string;
};

export type Requirement = {
  id: string;
  title: string;
  state: RequirementState;
  source_branch_id: string | null;
  /** 来源对话节点（整理为需求时关联的证据节点，PRD-SPEC-008） */
  source_node_ids: string[];
  /** 最新规格 revision；0 = 尚无规格 */
  latest_revision: number;
  /** 已确认的 revision；null = 未确认（PRD-SPEC-005：只有最新 revision 可确认） */
  confirmed_revision: number | null;
  /** 排队序号（confirmed/queued 时非空，1 起按 FIFO） */
  queue_position: number | null;
  /** 最新关联 Run（分组投影：RequirementState × 最新 Run，01 §8.1） */
  latest_run_id: string | null;
  created_at: string;
};

export type Notification = {
  id: string;
  severity: NotificationSeverity;
  message: string;
  source_workbench: NotificationSourceWorkbench;
  source_node_id: string | null;
  lifecycle: NotificationLifecycle;
  raised_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
};

/* ── 澄清与规格（01 §7.3、03 §5） ── */

/** 一次一个澄清问题（PRD-SPEC-004）：推荐选项 + 自定义输入 */
export type ClarificationRound = {
  id: string;
  requirement_id: string;
  question: string;
  options: string[];
  answer: string | null;
  state: "pending" | "answered";
  asked_at: string;
  answered_at: string | null;
};

/** 验收场景：Given/When/Then + 稳定 ID（PRD-SPEC-002） */
export type AcceptanceScenario = {
  id: string;
  given: string;
  when: string;
  then: string;
};

/** 显式约束必须引用用户消息或仓库事实；无来源内容只能作为假设（PRD-SPEC-003） */
export type SpecConstraint = {
  id: string;
  text: string;
  source: { kind: "user_message" | "repo_fact"; ref: string };
};

export type RequirementSpec = {
  goal: string;
  user_value: string;
  in_scope: string[];
  out_of_scope: string[];
  scenarios: AcceptanceScenario[];
  constraints: SpecConstraint[];
  non_goals: string[];
  risks: string[];
  assumptions: string[];
  /** 来源证据；证据修正是非语义修改（PRD-SPEC-007） */
  evidence: string[];
};

export type RequirementRevision = {
  requirement_id: string;
  revision: number;
  spec: RequirementSpec;
  /** 语义哈希：区分语义修改与证据修正（PRD-SPEC-007、BE-SPEC-003） */
  semantic_hash: string;
  created_at: string;
  source_graph_id: string;
  source_branch_id: string | null;
  source_node_ids: string[];
  confirmation: { revision: number; confirmed_at: string } | null;
};

/* ── Run、WorkPlan 与工作项（01 §7.4、§8.2） ── */

export type RunPhase =
  | "queued"
  | "waiting_workspace"
  | "planning"
  | "executing"
  | "validating"
  | "reviewing"
  | "publishing"
  | "pausing"
  | "paused"
  | "blocked"
  | "terminal";

export type RunOutcome = "delivered" | "blocked" | "cancelled" | "failed";

export type PublicationPath =
  "local" | "github_pull_request" | "gitlab_merge_request";

export type Run = {
  id: string;
  requirement_id: string;
  requirement_revision: number;
  phase: RunPhase;
  /** blocked/pausing/paused 时记录恢复原阶段（01 §8.2） */
  resume_phase: RunPhase | null;
  outcome: RunOutcome | null;
  blocked_reason: string | null;
  cancel_reason: string | null;
  /** 当前活动摘要（阶段、产出、风险、下一步的"当前活动"栏） */
  current_activity: string | null;
  /** Run 启动时冻结的发布路径与原因（PRD-PUB-003，运行期间不改变） */
  publication_path: PublicationPath;
  publication_frozen_reason: string;
  created_at: string;
  updated_at: string;
};

export type AttemptKind = "implementation" | "fix" | "rescue";

export type Attempt = {
  /** 1 = 实现；2/3 = 修复（PRD-QUAL-006 上限 1+2） */
  index: number;
  kind: AttemptKind;
  model: string;
  /** 第 3 次 attempt（第二次修复）升级到更强模型（PRD-QUAL-006） */
  upgraded: boolean;
  status: "running" | "completed" | "failed";
  summary: string | null;
  started_at: string;
  finished_at: string | null;
};

export type WorkItemKind = "work_item" | "merge_task";
export type WorkItemStatus =
  "pending" | "running" | "completed" | "failed" | "blocked";

export type WorkItem = {
  id: string;
  plan_id: string;
  kind: WorkItemKind;
  title: string;
  /** 计划序：合并任务按工作项 position 顺序执行 git merge（PRD-RUN-006） */
  position: number;
  depends_on: string[];
  scope_hint: string;
  /** 验收场景稳定 ID 引用（PRD-RUN-003） */
  scenario_ids: string[];
  verification_target: string;
  /** 并行批序号（0 起）；合并任务归入其终结的批（PRD-RUN-006） */
  batch: number;
  status: WorkItemStatus;
  attempts: Attempt[];
  artifact_summary: string | null;
  /** 合并任务：implementer 在 integration worktree 内解决冲突的过程摘要 */
  conflict_resolution: string | null;
};

export type PlanValidationReport = { ok: boolean; issues: string[] };

export type WorkPlan = {
  id: string;
  run_id: string;
  revision: number;
  items: WorkItem[];
  /** DAG / 场景覆盖 / 并行安全校验结果（PRD-RUN-005） */
  validation: PlanValidationReport;
  created_at: string;
};

/* ── 验证与审核（01 §7.5） ── */

export type VerificationVerdict =
  "clean" | "baseline_issues_only" | "new_regression" | "unavailable";

export type ValidationCommandResult = { exit_code: number; summary: string };

/** 每个阻断命令保存基线、最终状态、退出码与摘要（PRD-QUAL-002） */
export type ValidationEntry = {
  command: string;
  blocking: boolean;
  baseline: ValidationCommandResult | null;
  final: ValidationCommandResult | null;
  verdict: VerificationVerdict;
};

export type RunValidation = {
  run_id: string;
  entries: ValidationEntry[];
  overall: VerificationVerdict;
};

export type ReviewAngle = "correctness" | "quality" | "security";
export type FindingPriority = "P0" | "P1" | "P2" | "P3";

export type ReviewFinding = {
  id: string;
  angle: ReviewAngle;
  priority: FindingPriority;
  title: string;
  detail: string;
  resolved: boolean;
};

export type ReviewVerdict =
  "approved" | "approved_with_advisories" | "blocking_findings" | "unavailable";

/** 每个角度一次独立 reviewer 调用；输入隔离（PRD-QUAL-007） */
export type AngleReview = {
  angle: ReviewAngle;
  verdict: ReviewVerdict;
  /** 复审轮次（修复后只复查受影响角度） */
  rounds: number;
  /** 该角度可见的输入范围说明（输入隔离语义展示） */
  input_scope: string;
  findings: ReviewFinding[];
};

export type RunReview = {
  run_id: string;
  angles: AngleReview[];
  overall: ReviewVerdict;
};

/* ── 发布（01 §7.5、PRD-PUB-*） ── */

export type PublicationState =
  | "not_started"
  | "preparing"
  | "pushed"
  | "review_open"
  | "waiting_remote"
  | "merged"
  | "syncing_local"
  | "completed"
  | "failed";

export type Publication = {
  run_id: string;
  path: PublicationPath;
  frozen_reason: string;
  state: PublicationState;
  branch: string;
  commit: string | null;
  pr_url: string | null;
  /** 远端必要检查失败后的 CI 修复推送次数（上限 1，PRD-PUB-007） */
  ci_fix_attempts: number;
  /** 远端已合并而本地同步失败时组合展示两个事实（PRD-PUB-006） */
  remote_merged: boolean;
  local_synced: boolean;
  blocked_reason: string | null;
};

/* ── 文件工作台（FE-FILE-*） ── */

export type FileEntry = {
  /** 仓库相对路径（目录以 / 结尾与否均可，统一不带尾斜杠） */
  path: string;
  name: string;
  kind: "directory" | "file";
  /** 文件大小（字节）；目录为 null */
  size: number | null;
  /** 受限路径（.git/.raccoon-node/node_modules 等，BE-FILE-001 拒绝访问） */
  restricted: boolean;
};

export type FilePreviewKind =
  "text" | "binary" | "too_large" | "non_utf8" | "restricted";

export type FilePreview = {
  path: string;
  kind: FilePreviewKind;
  /** kind=text 时的文本行（上限内） */
  lines: string[] | null;
  truncated: boolean;
  /** 非 text 类型的明确原因说明（明确结果节点语义，FE-FILE-002） */
  note: string | null;
};

export type FileSearchResult = {
  path: string;
  line: number;
  excerpt: string;
};

/* ── Git 工作台（FE-GIT-*） ── */

export type GitChangeStatus =
  "staged" | "unstaged" | "untracked" | "conflicted";

export type GitChange = {
  path: string;
  status: GitChangeStatus;
  /** 文本 diff（untracked 为 null） */
  diff: string | null;
};

export type GitBranch = {
  name: string;
  current: boolean;
  ahead: number;
  behind: number;
};

export type GitRepoState = {
  root: string;
  branches: GitBranch[];
  changes: GitChange[];
  /** 仓库 writer lease（PRD-RUN-001）：活动 Run（含 waiting_workspace）持锁 */
  write_lock: { locked: boolean; owner_run_id: string | null };
  last_commit: string | null;
};

/* ── 终端工作台（FE-TERM-*） ── */

export type TerminalSessionState = "running" | "exited" | "disconnected";

export type TerminalSession = {
  id: string;
  title: string;
  state: TerminalSessionState;
  exit_code: number | null;
  created_at: string;
};

/* ── 模型与用量（01 §7.6：五角色、能力校验、软阈值、用量完整性） ── */

export type ModelRole =
  "qa" | "clarifier" | "planner" | "implementer" | "reviewer";

export type CapabilityName =
  | "text"
  | "image"
  | "streaming"
  | "tools"
  | "structured_output"
  | "long_context";

export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export type ModelCapability = Record<CapabilityName, CapabilitySupport>;

export type ModelInfo = {
  id: string;
  provider_id: string;
  label: string;
  capabilities: ModelCapability;
};

export type ProviderInfo = {
  id: string;
  label: string;
  /** Registry 描述的鉴权字段（FE-MODEL-001） */
  auth_fields: string[];
  /** 凭据只显示状态，不回显（PRD-MODEL-005） */
  credential: "configured" | "missing" | "invalid";
  models: ModelInfo[];
};

/** 模型引用：provider_id/model_id */
export type ModelRef = string;

export type RoleProfile = {
  role: ModelRole;
  primary: ModelRef | null;
  fallback: ModelRef | null;
};

export type UsageEntry = {
  id: string;
  run_id: string | null;
  role: ModelRole;
  provider_id: string;
  model_id: string;
  /** null = 未知 token：完整性显示"不完整"（PRD-USAGE-003） */
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  /** null = 价格未知：不得估造，显示"不完整"（PRD-USAGE-003） */
  cost_usd: number | null;
};

export type UsageState = {
  entries: UsageEntry[];
  soft_threshold_usd: number;
};

export type RoleAssignResult = {
  ok: boolean;
  message: string;
  at: string;
} | null;

/* ── 设置（FE-SET-*） ── */

export type NetworkPolicy =
  "offline" | "package_registry" | "git_remote" | "readonly_fetch";

export type AppSettings = {
  network_policy: NetworkPolicy;
  soft_threshold_usd: number;
  listen_host: string;
  listen_port: number;
  /** 保存后需重启才生效的键（FE-SET-002：保存和重启是两个动作） */
  pending_restart: string[];
  last_result: { ok: boolean; message: string; at: string } | null;
};

export type DiagnosticsInfo = {
  event_store_health: string;
  last_sequence: number;
  backups: string[];
  archive_hint: string;
};

/* ── 工作台危险操作确认链（FE-CANVAS-019：来源节点 → 确认节点 → 结果节点） ── */

export type WorkbenchActionKind =
  | "git_commit"
  | "git_push"
  | "git_pull"
  | "git_fetch"
  | "git_switch_branch"
  | "git_create_branch"
  | "git_discard"
  | "terminal_close";

export type WorkbenchAction = {
  id: string;
  kind: WorkbenchActionKind;
  title: string;
  /** 影响、目标与不可逆性说明 */
  impact: string;
  irreversible: boolean;
  /** 绑定来源节点（确认节点连接在来源节点之后） */
  source_node_id: string | null;
  /** 命令参数（如 commit message、分支名） */
  payload: Record<string, string>;
  /** prepare 阶段签发的短期确认 token（BE-API-004 两阶段契约语义） */
  confirm_token: string;
  state: "awaiting" | "confirmed" | "cancelled";
  result: { ok: boolean; message: string } | null;
  created_at: string;
};

/* ── 危险操作确认链（FE-CANVAS-019：来源节点 → 确认节点 → 结果节点） ── */

export type PendingActionKind =
  "force_deliver_unreviewed" | "abandon_run" | "publication_retry";

export type PendingAction = {
  id: string;
  kind: PendingActionKind;
  run_id: string;
  requirement_id: string | null;
  title: string;
  /** 影响、目标与不可逆性说明 */
  impact: string;
  irreversible: boolean;
  state: "awaiting" | "confirmed" | "cancelled";
  result: { ok: boolean; message: string } | null;
  created_at: string;
};

/* ── 事件信封与 NDJSON 事件联合（01 §8.3、02 §9.2） ── */

export const EVENT_SCHEMA_VERSION = 1;

export type EventType =
  | "conversation.node.created"
  | "conversation.node.delta"
  | "conversation.node.state_changed"
  | "conversation.branch.created"
  | "notification.raised"
  | "notification.acknowledged"
  | "notification.resolved"
  | "requirement.created"
  | "requirement.updated"
  | "requirement.clarification_asked"
  | "requirement.clarification_answered"
  | "requirement.revision_created"
  | "requirement.queue_reordered"
  | "run.updated"
  | "plan.updated"
  | "validation.updated"
  | "review.updated"
  | "publication.updated"
  | "action.updated"
  | "workbench_action.updated"
  | "git.updated"
  | "terminal.session_updated"
  | "models.updated"
  | "settings.updated"
  | "system.resync_required";

export type DomainEventPayload = {
  "conversation.node.created": { node: ConversationNode };
  "conversation.node.delta": {
    node_id: string;
    node_sequence: number;
    delta: string;
  };
  "conversation.node.state_changed": {
    node_id: string;
    state: ConversationNodeState;
    completed_at?: string | null;
    tool_activity?: ToolActivity;
  };
  "conversation.branch.created": {
    branch: ConversationBranch;
    /** 被新分支共享（继承）的祖先节点 id 列表 */
    shared_node_ids: string[];
  };
  "notification.raised": { notification: Notification };
  "notification.acknowledged": {
    notification_id: string;
    acknowledged_at: string;
  };
  "notification.resolved": { notification_id: string; resolved_at: string };
  "requirement.created": { requirement: Requirement };
  /** 需求状态/队列/确认/关联 Run 变化（全量携带实体，投影直接替换） */
  "requirement.updated": { requirement: Requirement };
  "requirement.clarification_asked": { round: ClarificationRound };
  "requirement.clarification_answered": { round: ClarificationRound };
  "requirement.revision_created": { revision: RequirementRevision };
  "requirement.queue_reordered": { requirement_ids: string[] };
  /** Run 创建与一切 phase/outcome/活动变化（全量携带实体） */
  "run.updated": { run: Run };
  "plan.updated": { plan: WorkPlan };
  "validation.updated": { validation: RunValidation };
  "review.updated": { review: RunReview };
  "publication.updated": { publication: Publication };
  /** 危险操作请求/确认/取消/结果（FE-CANVAS-019 确认链事实） */
  "action.updated": { action: PendingAction };
  /** 工作台危险操作（git/terminal）两阶段确认链 */
  "workbench_action.updated": { action: WorkbenchAction };
  /** Git 仓库状态全量投影（写操作与写锁变化后整体替换） */
  "git.updated": { state: GitRepoState };
  /** 终端会话生命周期（正文不进入事件，FE-TERM-002）；closed=true 表示会话已移除 */
  "terminal.session_updated": { session: TerminalSession; closed?: boolean };
  /** Provider/角色配置/用量全量投影 */
  "models.updated": {
    providers: ProviderInfo[];
    roles: RoleProfile[];
    usage: UsageState;
    last_result: RoleAssignResult;
  };
  "settings.updated": { settings: AppSettings };
  "system.resync_required": { reason: string; min_sequence?: number };
};

export type EventAggregateType =
  | "conversation"
  | "notification"
  | "requirement"
  | "run"
  | "action"
  | "git"
  | "terminal"
  | "models"
  | "settings"
  | "system";

export type EventEnvelope<T extends EventType = EventType> = {
  schema_version: number;
  sequence: number;
  event_id: string;
  occurred_at: string;
  aggregate_type: EventAggregateType;
  aggregate_id: string;
  event_type: T;
  payload: DomainEventPayload[T];
};

/* ── 快照（StateFile 形状，01 §8.3） ── */

export type ApplicationSnapshot = {
  format_version: number;
  last_sequence: number;
  written_at: string;
  state_hash: string;
  state: {
    conversation: {
      graph_id: string;
      root_branch_id: string;
      nodes: ConversationNode[];
      branches: ConversationBranch[];
    };
    notifications: Notification[];
    requirements: Requirement[];
    clarifications: ClarificationRound[];
    revisions: RequirementRevision[];
    runs: Run[];
    plans: WorkPlan[];
    validations: RunValidation[];
    reviews: RunReview[];
    publications: Publication[];
    actions: PendingAction[];
    workbench_actions: WorkbenchAction[];
    git: GitRepoState;
    terminals: TerminalSession[];
    models: {
      providers: ProviderInfo[];
      roles: RoleProfile[];
      usage: UsageState;
      last_result: RoleAssignResult;
    };
    settings: AppSettings;
  };
};
