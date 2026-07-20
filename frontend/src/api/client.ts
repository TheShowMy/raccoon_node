import type {
  AppSettings,
  ApplicationSnapshot,
  ClarificationAnswer,
  ConversationBranch,
  ConversationGraphSnapshot,
  ConversationSession,
  DetectedIntent,
  DiagnosticsInfo,
  FileEntry,
  FilePreview,
  FileSearchResult,
  GitMutationResult,
  IntentMode,
  ModelRef,
  ModelRole,
  PendingActionKind,
  PublicationPath,
  RequirementSpec,
  WorkItem,
  WorkbenchActionKind,
  WorkbenchKind,
} from "./types";

export type SendMessageInput = {
  session_id: string;
  branch_id: string;
  text: string;
  /** auto 由后端判定；question/change 为用户覆盖，只影响当前提交（FE-CHAT-002） */
  intent: IntentMode;
  /** 仓库文件引用（最多 8 个，PRD-CHAT-001） */
  file_refs?: string[];
  /** 本轮 mock 只接收安全元数据；真实二进制上传留给后端阶段。 */
  images?: ImageAttachmentInput[];
};

export type ImageAttachmentInput = {
  name: string;
  mime: string;
  size: number;
};

export type SendMessageResult = {
  user_node_id: string;
  detected_intent: DetectedIntent;
};

export type WorkbenchSummary = {
  kind: WorkbenchKind;
  title: string;
  /** 概览卡最多三条高价值摘要（02 §3.2） */
  lines: string[];
};

/** 确认摘要（FE-SPEC-005）：预计发布路径、模型角色、任务预算、脏工作区阻断 */
export type ConfirmationPreview = {
  requirement_id: string;
  revision: number;
  publication_path: PublicationPath;
  publication_reason: string;
  model_roles: { role: string; model: string }[];
  default_task_budget_usd: number;
  effective_task_budget_usd: number;
  workspace_dirty: boolean;
  workspace_note: string | null;
};

/** 演示控制台状态（假数据层专用，验收走查分支场景；后端阶段移除） */
export type ScenarioState = {
  autoplay: boolean;
  /** 自动播放每步延迟（测试可设为 0） */
  step_delay_ms: number;
  flags: {
    remote_ready: boolean;
    dirty_workspace: boolean;
    new_regression: boolean;
    review_unavailable: boolean;
    rescue_demo: boolean;
    ci_fail_once: boolean;
    local_sync_fail: boolean;
    /** CI 修复推送后仍失败/远端拒绝合并（PRD-PUB-007 blocked 分支） */
    ci_reject: boolean;
  };
  /** 正在等待手动推进的 Run */
  awaiting_step_run_id: string | null;
};

export type ScenarioCommand =
  | { type: "set_autoplay"; value: boolean }
  | { type: "step" }
  | { type: "set_flag"; flag: keyof ScenarioState["flags"]; value: boolean }
  | { type: "set_step_delay"; value: number };

/**
 * REST/命令面接口。P1/P2 由 FakeBackend 实现；后端阶段替换为 OpenAPI 生成客户端，
 * 业务组件不得直接拼接 URL（02 §2.2）。
 */
export interface RaccoonApi {
  getSnapshot(): Promise<ApplicationSnapshot>;
  createConversationSession(input: { idempotency_key: string }): Promise<{
    session: ConversationSession;
    graph: ConversationGraphSnapshot;
  }>;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  /** 停止当前分支响应：已产出内容保留，活动节点转 aborted（PRD-CHAT-005） */
  abortResponse(session_id: string, branch_id: string): Promise<void>;
  /** 从历史用户节点开新分支；其他节点归一到最近祖先用户节点（PRD-CHAT-009） */
  branchFrom(input: {
    session_id: string;
    node_id: string;
  }): Promise<{ branch: ConversationBranch }>;
  acknowledgeNotification(notification_id: string): Promise<void>;
  /** 工作台概览卡摘要 */
  getWorkbenchSummary(kind: WorkbenchKind): Promise<WorkbenchSummary>;

  /* ── 需求交付（03 §3：/chat/requirements、/requirements/*、/runs/*） ── */

  /** 从连续对话节点整理为需求（PRD-CHAT-003）：来源与证据自动关联 */
  createRequirementFromChat(input: {
    session_id: string;
    branch_id: string;
    node_ids: string[];
    title?: string;
  }): Promise<{ requirement_id: string }>;
  /** 提交结构化澄清回答（FE-SPEC-001：单选、多选或自由文本） */
  answerClarification(input: {
    requirement_id: string;
    round_id: string;
    answer: ClarificationAnswer;
  }): Promise<void>;
  /** 取消尚未确认的需求流程并释放当前分支输入权。 */
  cancelRequirement(requirement_id: string): Promise<void>;
  /**
   * 保存规格编辑（PRD-SPEC-005/007）：产生新 revision；
   * semantic_hash 变化 → 撤销确认并取消未终态 Run；base_revision 过期返回冲突。
   */
  updateSpec(input: {
    requirement_id: string;
    base_revision: number;
    spec: RequirementSpec;
  }): Promise<{ revision: number; conflict: boolean }>;
  /** 确认指定 revision：入队并自动生成 WorkPlan 启动 Run（PRD-RUN-002 无计划确认） */
  confirmRequirement(input: {
    requirement_id: string;
    revision: number;
    task_budget_usd: number;
  }): Promise<{ run_id: string | null; conflict: boolean }>;
  /** 确认摘要预览（FE-SPEC-005） */
  getConfirmationPreview(requirement_id: string): Promise<ConfirmationPreview>;
  /** 队列重排（FE-RUN-001）：活动项（含 waiting_workspace）不可移动 */
  reorderQueue(input: { requirement_ids: string[] }): Promise<{ ok: boolean }>;
  pauseRun(run_id: string): Promise<void>;
  resumeRun(run_id: string): Promise<void>;
  /** blocked → 重试：重置相关修复上限继续（PRD-RUN-007），非危险直接命令 */
  retryRun(run_id: string): Promise<void>;
  /** 暂停后编辑 pending 工作项（PRD-RUN-004/005）：生成新 plan revision 并重新校验 */
  updateWorkItem(input: {
    run_id: string;
    item_id: string;
    patch: Partial<
      Pick<
        WorkItem,
        "title" | "scenario_ids" | "verification_target" | "depends_on"
      >
    >;
  }): Promise<{ plan_revision: number }>;
  /** 危险操作两阶段：request 产生确认节点事实，confirm 执行并产生结果节点 */
  requestAction(input: {
    kind: PendingActionKind;
    run_id: string;
  }): Promise<{ action_id: string }>;
  confirmAction(action_id: string): Promise<void>;
  cancelAction(action_id: string): Promise<void>;

  /* ── 文件工作台（FE-FILE-*） ── */

  /** 目录列表（目录在前按名称排序）；受限路径标记 restricted（FE-FILE-001） */
  listDirectory(path: string): Promise<FileEntry[]>;
  /** 搜索：路径子串 + 文本行匹配；受限路径不进入结果（FE-FILE-001） */
  searchFiles(query: string): Promise<FileSearchResult[]>;
  /** 文件预览：文本/二进制/过大/非 UTF-8/受限 明确分类（FE-FILE-002） */
  getFilePreview(path: string): Promise<FilePreview>;

  /* ── Git 工作台（FE-GIT-*；写操作经事件投影，写锁占用返回 409 语义） ── */

  stageChanges(paths: string[]): Promise<GitMutationResult>;
  unstageChanges(paths: string[]): Promise<GitMutationResult>;

  /* ── 工作台危险操作两阶段（prepare/confirm 语义；git/terminal 共用） ── */

  requestWorkbenchAction(input: {
    kind: WorkbenchActionKind;
    payload?: Record<string, string>;
    source_node_id?: string | null;
  }): Promise<{ action_id: string }>;
  confirmWorkbenchAction(input: {
    action_id: string;
    confirm_token: string;
  }): Promise<void>;
  cancelWorkbenchAction(action_id: string): Promise<void>;

  /* ── 终端工作台（FE-TERM-*；正文走侧信道不进入业务事件） ── */

  createTerminal(): Promise<{ session_id: string }>;
  renameTerminal(input: { session_id: string; title: string }): Promise<void>;
  /** 直接关闭（仅 exited/disconnected；running 会话走 terminal_close 确认链） */
  closeTerminal(session_id: string): Promise<void>;
  terminalInput(input: { session_id: string; data: string }): Promise<void>;
  resizeTerminal(input: {
    session_id: string;
    cols: number;
    rows: number;
  }): Promise<void>;
  /** 演示：模拟连接断开 / 重连（断连与进程退出是不同状态，FE-TERM-002） */
  disconnectTerminal(session_id: string): Promise<void>;
  reconnectTerminal(session_id: string): Promise<void>;
  /** mock WebSocket 侧信道：订阅终端输出（不经过 NDJSON 业务事件流） */
  subscribeTerminalOutput(
    session_id: string,
    onData: (data: string) => void,
  ): () => void;

  /* ── 模型配置（设置工作台；凭据只新建/替换不回显） ── */

  setProviderCredential(input: {
    provider_id: string;
    secret: string;
  }): Promise<void>;
  /** 角色配置保存：能力校验失败时保存被阻止并返回原因（PRD-MODEL-004） */
  assignRoleModel(input: {
    role: ModelRole;
    slot: "primary" | "fallback";
    model: ModelRef | null;
  }): Promise<{ ok: boolean; message: string }>;

  /* ── 设置（FE-SET-*） ── */

  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  /** 模拟重启：pending_restart 清空，监听设置生效（保存和重启是两个动作） */
  restartSystem(): Promise<void>;
  getDiagnostics(): Promise<DiagnosticsInfo>;

  /* ── 演示控制台（假数据层专用） ── */
  getScenarioState(): Promise<ScenarioState>;
  scenarioControl(command: ScenarioCommand): Promise<ScenarioState>;

  /**
   * 打开 NDJSON 事件流，生产形态为
   * `fetch(GET /api/v1/events?after=<sequence>)` 的响应体（FE-EVENT-001）。
   */
  openEventStream(after: number): Promise<ReadableStream<Uint8Array>>;
}
