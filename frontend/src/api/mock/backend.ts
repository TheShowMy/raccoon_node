import { detectIntent } from "../intent";
import type {
  ConfirmationPreview,
  RaccoonApi,
  ScenarioCommand,
  ScenarioState,
  SendMessageInput,
  SendMessageResult,
  WorkbenchSummary,
} from "../client";
import {
  EVENT_SCHEMA_VERSION,
  type AppSettings,
  type ApplicationSnapshot,
  type ClarificationAnswer,
  type ConversationBranch,
  type ConversationGraphSnapshot,
  type ConversationNode,
  type ConversationSession,
  type DiagnosticsInfo,
  type DomainEventPayload,
  type EventAggregateType,
  type EventEnvelope,
  type EventType,
  type FileEntry,
  type FilePreview,
  type FileSearchResult,
  type ModelRef,
  type ModelRole,
  type Notification,
  type NotificationSeverity,
  type NotificationSourceWorkbench,
  type PendingActionKind,
  type RequirementSpec,
  type ToolActivity,
  type WorkbenchAction,
  type WorkbenchActionKind,
  type WorkItem,
  type WorkbenchKind,
} from "../types";
import { DeliveryModule } from "./delivery";
import { FilesModule } from "./files";
import { GitModule } from "./git";
import { ModelsModule } from "./models";
import { selectScript, type ScriptStep } from "./scripts";
import { SettingsModule } from "./settings";
import { TerminalModule } from "./terminal";
import { UsageModule } from "./usage";

const INITIAL_SESSION_ID = "s-main";
const INITIAL_GRAPH_ID = "g-main";
const INITIAL_ROOT_BRANCH_ID = "b-main";

const MAX_EVENT_LOG = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const latency = () => sleep(40 + Math.random() * 80);
const now = () => new Date().toISOString();

/** 实例序号：测试并行多个 FakeBackend 时避免实体 id 碰撞（生产单实例无影响） */
let backendInstanceCounter = 0;

const WORKBENCH_TITLES: Record<WorkbenchKind, string> = {
  delivery: "需求交付",
  files: "文件",
  git: "Git",
  terminal: "终端",
  usage: "用量统计",
  settings: "设置",
};

/** 工作台危险命令的确认节点文案（FE-CANVAS-019：动作、影响、目标、不可逆性） */
function workbenchActionCopy(
  kind: WorkbenchActionKind,
  payload: Record<string, string>,
): { title: string; impact: string; irreversible: boolean } {
  switch (kind) {
    case "git_commit":
      return {
        title: `提交暂存变更：${payload.message || "（无消息）"}`,
        impact: "在当前分支创建一个新提交；提交进入历史后只能通过新提交回退。",
        irreversible: false,
      };
    case "git_push":
      return {
        title: "推送到远端 origin",
        impact: "远端分支将被前进到本地提交，其他协作者可见。",
        irreversible: false,
      };
    case "git_pull":
      return {
        title: "拉取远端变更",
        impact: "远端提交将合并/fast-forward 到当前分支。",
        irreversible: false,
      };
    case "git_fetch":
      return {
        title: "抓取远端引用",
        impact: "只更新远端跟踪分支，不改动工作区。",
        irreversible: false,
      };
    case "git_switch_branch":
      return {
        title: `切换分支到 ${payload.branch}`,
        impact: "工作区将切换到目标分支；未提交变更可能被携带或阻止。",
        irreversible: false,
      };
    case "git_create_branch":
      return {
        title: `创建并切换到分支 ${payload.branch}`,
        impact: "基于当前 HEAD 创建新分支。",
        irreversible: false,
      };
    case "git_discard":
      return {
        title: `丢弃修改：${payload.path}`,
        impact: "工作区修改将被永久删除，无法从 Git 恢复。",
        irreversible: true,
      };
    case "terminal_close":
      return {
        title: `关闭运行中的终端会话「${payload.title ?? payload.session_id}」`,
        impact: "会话进程树将被终止，未保存的输出丢失。",
        irreversible: true,
      };
    case "conversation_redact":
      return {
        title: "删除对话节点可见内容",
        impact:
          "节点正文与附件引用将显示为已删除；节点 ID、连线、分支和业务证据关系保留。",
        irreversible: true,
      };
    case "conversation_new_session":
      return {
        title: "新建独立会话",
        impact:
          "停止当前流式响应并保留已生成内容；未完成需求和草稿留在旧会话，随后切换到空白会话。",
        irreversible: false,
      };
  }
}

/**
 * P1 假后端：内存对话 DAG + 假延迟 + 事件总线。
 * 事件先写入内存日志（附带全局单调 sequence），再推送给订阅的 NDJSON 流，
 * 与真实后端的"先写事件、再推送"顺序一致（PRD-EVENT-002）。
 */
export class FakeBackend implements RaccoonApi {
  private sequence = 0;
  private eventCounter = 0;
  private nodeCounter = 0;
  private branchCounter = 0;
  private sessionCounter = 0;
  private notificationCounter = 0;
  private readonly log: EventEnvelope[] = [];
  private readonly subscribers = new Set<(envelope: EventEnvelope) => void>();
  private readonly nodes = new Map<string, ConversationNode>();
  private readonly branches = new Map<string, ConversationBranch>();
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly sessionIdempotency = new Map<string, string>();
  private activeSessionId = INITIAL_SESSION_ID;
  private readonly notifications = new Map<string, Notification>();
  private readonly runs = new Map<string, AbortController>();
  private demoNotificationsStarted = false;
  private readonly delivery: DeliveryModule;
  private readonly files: FilesModule;
  private readonly git: GitModule;
  private readonly terminal: TerminalModule;
  private readonly models: ModelsModule;
  private readonly usage: UsageModule;
  private readonly settings: SettingsModule;
  private workbenchActionCounter = 0;
  private readonly workbenchActions = new Map<string, WorkbenchAction>();
  private readonly idPrefix = `i${++backendInstanceCounter}`;

  constructor() {
    const createdAt = now();
    this.sessions.set(INITIAL_SESSION_ID, {
      id: INITIAL_SESSION_ID,
      graph_id: INITIAL_GRAPH_ID,
      root_branch_id: INITIAL_ROOT_BRANCH_ID,
      created_at: createdAt,
      updated_at: createdAt,
    });
    this.branches.set(INITIAL_ROOT_BRANCH_ID, {
      id: INITIAL_ROOT_BRANCH_ID,
      graph_id: INITIAL_GRAPH_ID,
      anchor_node_id: null,
      parent_branch_id: null,
      created_at: createdAt,
    });
    this.delivery = new DeliveryModule({
      idPrefix: this.idPrefix,
      emit: (aggregateType, aggregateId, eventType, payload) =>
        this.emit(aggregateType, aggregateId, eventType, payload),
      notify: (severity, message, sourceWorkbench, sourceNodeId) =>
        this.raiseNotification(
          severity,
          message,
          sourceWorkbench,
          sourceNodeId,
        ),
      resolveNotification: (notificationId) =>
        this.resolveNotification(notificationId),
      nodeContent: (nodeId) => this.nodes.get(nodeId)?.content ?? null,
      appendConversationNode: (input) => {
        return this.createNode({
          branch_id: input.branch_id,
          kind: input.kind,
          state: "completed",
          content: input.content,
          completed_at: now(),
          requirement_id: input.requirement_id,
          requirement_revision: input.requirement_revision ?? null,
          clarification_round_id: input.clarification_round_id ?? null,
        }).id;
      },
      defaultTaskBudget: () =>
        this.settings?.snapshotState().default_task_budget_usd ?? 25,
      recordRunUsage: (input) => this.usage.recordRunUsage(input),
      latency: () => latency().then(() => undefined),
    });
    this.files = new FilesModule({
      latency: () => latency().then(() => undefined),
    });
    this.git = new GitModule({
      idPrefix: this.idPrefix,
      emit: (aggregateType, aggregateId, eventType, payload) =>
        this.emit(aggregateType, aggregateId, eventType, payload),
      latency: () => latency().then(() => undefined),
      writeLock: () => this.delivery.writeLockInfo(),
    });
    this.terminal = new TerminalModule({
      idPrefix: this.idPrefix,
      emit: (aggregateType, aggregateId, eventType, payload) =>
        this.emit(aggregateType, aggregateId, eventType, payload),
      latency: () => latency().then(() => undefined),
    });
    this.models = new ModelsModule({
      emit: (aggregateType, aggregateId, eventType, payload) =>
        this.emit(aggregateType, aggregateId, eventType, payload),
      latency: () => latency().then(() => undefined),
    });
    this.usage = new UsageModule({
      emit: (aggregateType, aggregateId, eventType, payload) =>
        this.emit(aggregateType, aggregateId, eventType, payload),
    });
    this.settings = new SettingsModule({
      emit: (aggregateType, aggregateId, eventType, payload) =>
        this.emit(aggregateType, aggregateId, eventType, payload),
      notify: (severity, message, sourceWorkbench, sourceNodeId) =>
        this.raiseNotification(
          severity,
          message,
          sourceWorkbench,
          sourceNodeId,
        ),
      latency: () => latency().then(() => undefined),
      lastSequence: () => this.sequence,
    });
  }

  /* ── 事件总线 ── */

  private emit<T extends EventType>(
    aggregateType: EventAggregateType,
    aggregateId: string,
    eventType: T,
    payload: DomainEventPayload[T],
  ) {
    const envelope: EventEnvelope<T> = {
      schema_version: EVENT_SCHEMA_VERSION,
      sequence: ++this.sequence,
      event_id: `e-${++this.eventCounter}`,
      occurred_at: now(),
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_type: eventType,
      payload,
    };
    this.log.push(envelope);
    if (this.log.length > MAX_EVENT_LOG) {
      this.log.splice(0, this.log.length - MAX_EVENT_LOG);
    }
    for (const subscriber of this.subscribers) subscriber(envelope);
  }

  openEventStream(after: number): Promise<ReadableStream<Uint8Array>> {
    this.startDemoNotifications();
    const encoder = new TextEncoder();
    const replay = this.log.filter((entry) => entry.sequence > after);
    let subscriber: ((envelope: EventEnvelope) => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const push = (envelope: EventEnvelope) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(envelope)}\n`));
          } catch {
            // 流已被消费端取消
          }
        };
        for (const envelope of replay) push(envelope);
        subscriber = push;
        this.subscribers.add(push);
      },
      cancel: () => {
        if (subscriber) this.subscribers.delete(subscriber);
      },
    });
    return Promise.resolve(stream);
  }

  /* ── 快照 ── */

  getSnapshot(): Promise<ApplicationSnapshot> {
    return latency().then(() => ({
      format_version: 1,
      last_sequence: this.sequence,
      written_at: now(),
      state_hash: "mock-state-hash",
      state: {
        conversation: {
          active_session_id: this.activeSessionId,
          sessions: [...this.sessions.values()],
          graphs: [...this.sessions.values()].map((session) =>
            this.graphSnapshot(session),
          ),
        },
        notifications: [...this.notifications.values()],
        ...this.delivery.snapshotState(),
        workbench_actions: [...this.workbenchActions.values()],
        git: this.git.snapshotState(),
        terminals: this.terminal.snapshotState(),
        models: this.models.snapshotState(),
        usage: this.usage.snapshotState(),
        settings: this.settings.snapshotState(),
      },
    }));
  }

  /* ── 对话命令 ── */

  private graphSnapshot(
    session: ConversationSession,
  ): ConversationGraphSnapshot {
    return {
      graph_id: session.graph_id,
      root_branch_id: session.root_branch_id,
      nodes: [...this.nodes.values()].filter(
        (node) => node.graph_id === session.graph_id,
      ),
      branches: [...this.branches.values()].filter(
        (branch) => branch.graph_id === session.graph_id,
      ),
    };
  }

  private sessionForGraph(graphId: string): ConversationSession {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.graph_id === graphId,
    );
    if (!session) throw new Error(`conversation: 未找到图 ${graphId}`);
    return session;
  }

  async createConversationSession(input: { idempotency_key: string }): Promise<{
    session: ConversationSession;
    graph: ConversationGraphSnapshot;
  }> {
    await latency();
    const existingId = this.sessionIdempotency.get(input.idempotency_key);
    if (existingId) {
      const existing = this.sessions.get(existingId)!;
      this.activeSessionId = existing.id;
      return { session: existing, graph: this.graphSnapshot(existing) };
    }
    const index = ++this.sessionCounter;
    const createdAt = now();
    const session: ConversationSession = {
      id: `s-${this.idPrefix}-${index}`,
      graph_id: `g-${this.idPrefix}-${index}`,
      root_branch_id: `b-${this.idPrefix}-root-${index}`,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const root: ConversationBranch = {
      id: session.root_branch_id,
      graph_id: session.graph_id,
      anchor_node_id: null,
      parent_branch_id: null,
      created_at: createdAt,
    };
    this.sessions.set(session.id, session);
    this.branches.set(root.id, root);
    this.sessionIdempotency.set(input.idempotency_key, session.id);
    this.activeSessionId = session.id;
    const graph = this.graphSnapshot(session);
    this.emit(
      "conversation",
      session.graph_id,
      "conversation.session.created",
      {
        session,
        graph,
        active: true,
      },
    );
    return { session, graph };
  }

  private headOf(branchId: string): string | null {
    let head: string | null = null;
    for (const node of this.nodes.values()) {
      if (!node.branch_ids.includes(branchId)) continue;
      if (
        !head ||
        node.created_at >= (this.nodes.get(head)?.created_at ?? "")
      ) {
        // 末端 = 没有子节点的可见节点；演示数据下按创建顺序近似
        head = node.id;
      }
    }
    return head;
  }

  private createNode(
    partial: Pick<ConversationNode, "kind" | "state"> &
      Partial<ConversationNode> & { branch_id: string },
  ): ConversationNode {
    const { branch_id, kind, state, ...rest } = partial;
    const branch = this.branches.get(branch_id);
    if (!branch) throw new Error(`conversation: 未找到分支 ${branch_id}`);
    const parentId = rest.parent_ids?.[0] ?? this.headOf(branch_id);
    const node: ConversationNode = {
      id: `n-${this.idPrefix}-${++this.nodeCounter}`,
      graph_id: branch.graph_id,
      content: "",
      node_sequence: 0,
      intent: null,
      created_at: now(),
      completed_at: null,
      requirement_id: null,
      requirement_revision: null,
      clarification_round_id: null,
      redacted_at: null,
      tool_activity: null,
      ...rest,
      kind,
      state,
      parent_ids: parentId ? [parentId] : [],
      branch_ids: [branch_id],
    };
    this.nodes.set(node.id, node);
    this.emit("conversation", node.graph_id, "conversation.node.created", {
      node,
    });
    return node;
  }

  private streamChunks(
    node: ConversationNode,
    chunks: string[],
    signal: AbortSignal,
  ): Promise<boolean> {
    let current = node;
    return (async () => {
      for (const chunk of chunks) {
        if (signal.aborted) return false;
        await sleep(140 + Math.random() * 160);
        if (signal.aborted) return false;
        const nextSequence = current.node_sequence + 1;
        current = {
          ...current,
          content: current.content + chunk,
          node_sequence: nextSequence,
        };
        this.nodes.set(current.id, current);
        this.emit("conversation", current.graph_id, "conversation.node.delta", {
          node_id: current.id,
          node_sequence: nextSequence,
          delta: chunk,
        });
      }
      return true;
    })();
  }

  private finishNode(
    node: ConversationNode,
    state: ConversationNode["state"],
    toolActivity?: ToolActivity,
  ) {
    const finished = {
      ...node,
      state,
      completed_at: now(),
      tool_activity: toolActivity ?? node.tool_activity,
    };
    this.nodes.set(finished.id, finished);
    this.emit(
      "conversation",
      finished.graph_id,
      "conversation.node.state_changed",
      {
        node_id: finished.id,
        state,
        completed_at: finished.completed_at,
        ...(toolActivity ? { tool_activity: toolActivity } : {}),
      },
    );
  }

  private abortActiveNodes(branchId: string) {
    for (const node of this.nodes.values()) {
      if (!node.branch_ids.includes(branchId)) continue;
      if (node.state !== "streaming" && node.state !== "running") continue;
      const toolActivity =
        node.tool_activity &&
        (node.tool_activity.state === "waiting" ||
          node.tool_activity.state === "running")
          ? {
              ...node.tool_activity,
              state: "failed" as const,
              finished_at: now(),
            }
          : undefined;
      this.finishNode(node, "aborted", toolActivity);
    }
  }

  private async runScript(
    branchId: string,
    steps: ScriptStep[],
    signal: AbortSignal,
    userText: string,
    context: { changeIntent: boolean; userNodeId: string },
  ) {
    let answered = false;
    for (const step of steps) {
      if (signal.aborted) break;
      if (step.kind === "process") {
        const node = this.createNode({
          kind: "process",
          state: "streaming",
          branch_id: branchId,
        });
        const done = await this.streamChunks(node, step.chunks, signal);
        if (!done) break;
        this.finishNode(this.nodes.get(node.id)!, "completed");
        continue;
      }
      if (step.kind === "tool") {
        const node = this.createNode({
          kind: "tool",
          state: "running",
          branch_id: branchId,
          tool_activity: {
            name: step.name,
            purpose: step.purpose,
            state: "waiting",
            started_at: null,
            finished_at: null,
            duration_ms: null,
            summary: null,
          },
        });
        await sleep(250);
        if (signal.aborted) break;
        const started = Date.now();
        const running: ToolActivity = {
          ...node.tool_activity!,
          state: "running",
          started_at: now(),
        };
        this.nodes.set(node.id, { ...node, tool_activity: running });
        this.emit(
          "conversation",
          node.graph_id,
          "conversation.node.state_changed",
          {
            node_id: node.id,
            state: "running",
            tool_activity: running,
          },
        );
        await sleep(step.duration_ms);
        if (signal.aborted) break;
        const final: ToolActivity = {
          ...running,
          state: step.fails ? "failed" : "completed",
          finished_at: now(),
          duration_ms: Date.now() - started,
          summary: step.summary,
        };
        this.finishNode(
          this.nodes.get(node.id)!,
          step.fails ? "failed" : "completed",
          final,
        );
        continue;
      }
      // answer
      const node = this.createNode({
        kind: "assistant_answer",
        state: "streaming",
        branch_id: branchId,
      });
      const done = await this.streamChunks(node, step.chunks, signal);
      if (!done) break;
      this.finishNode(this.nodes.get(node.id)!, "completed");
      answered = true;
    }
    if (answered && context.changeIntent) {
      // PRD-CHAT-013：意图判定为 change 时自动创建需求草稿并启动澄清（用户可取消）
      const answerHead = this.headOf(branchId);
      const nodeIds = [context.userNodeId, answerHead].filter(
        (id): id is string => Boolean(id),
      );
      await this.delivery.createRequirementFromChat({
        session_id: this.sessionForGraph(this.branches.get(branchId)!.graph_id)
          .id,
        branch_id: branchId,
        node_ids: nodeIds,
        title: userText.trim().slice(0, 24),
      });
    }
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    await latency();
    const session = this.sessions.get(input.session_id);
    const branch = this.branches.get(input.branch_id);
    if (!session || !branch || branch.graph_id !== session.graph_id) {
      throw new Error("send_message: 会话与分支不匹配");
    }
    const detected =
      input.intent === "auto" ? detectIntent(input.text) : input.intent;
    const userNode = this.createNode({
      kind: "user_message",
      state: "completed",
      branch_id: input.branch_id,
      content: input.text,
      intent: detected,
      completed_at: now(),
    });
    const controller = new AbortController();
    this.runs.set(input.branch_id, controller);
    const steps = selectScript(input.text, detected === "change");
    void this.runScript(input.branch_id, steps, controller.signal, input.text, {
      changeIntent: detected === "change",
      userNodeId: userNode.id,
    }).finally(() => {
      this.runs.delete(input.branch_id);
    });
    return { user_node_id: userNode.id, detected_intent: detected };
  }

  async abortResponse(session_id: string, branch_id: string): Promise<void> {
    await latency();
    this.abortResponseImmediately(session_id, branch_id);
  }

  private abortResponseImmediately(session_id: string, branch_id: string) {
    const session = this.sessions.get(session_id);
    if (!session || this.branches.get(branch_id)?.graph_id !== session.graph_id)
      return;
    this.runs.get(branch_id)?.abort();
    this.runs.delete(branch_id);
    this.abortActiveNodes(branch_id);
  }

  async branchFrom(input: {
    session_id: string;
    node_id: string;
  }): Promise<{ branch: ConversationBranch }> {
    await latency();
    // 其他节点归一到最近祖先用户节点（PRD-CHAT-009）
    let anchor = this.nodes.get(input.node_id);
    const session = this.sessions.get(input.session_id);
    if (!session || anchor?.graph_id !== session.graph_id) {
      throw new Error("branch_from: 会话与锚点不匹配");
    }
    while (anchor && anchor.kind !== "user_message") {
      const parentId: string | undefined =
        anchor.parent_ids[anchor.parent_ids.length - 1];
      anchor = parentId ? this.nodes.get(parentId) : undefined;
    }
    if (!anchor) throw new Error("branch_from: 未找到可锚定的用户节点");
    const shared: ConversationNode[] = [];
    const visited = new Set<string>();
    let current: ConversationNode | undefined = anchor;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      shared.unshift(current);
      const parentId: string | undefined =
        current.parent_ids[current.parent_ids.length - 1];
      current = parentId ? this.nodes.get(parentId) : undefined;
    }
    const branch: ConversationBranch = {
      id: `b-${this.idPrefix}-${++this.branchCounter}`,
      graph_id: session.graph_id,
      anchor_node_id: anchor.id,
      parent_branch_id:
        anchor.branch_ids[anchor.branch_ids.length - 1] ??
        session.root_branch_id,
      created_at: now(),
    };
    this.branches.set(branch.id, branch);
    for (const node of shared) {
      if (!node.branch_ids.includes(branch.id)) {
        this.nodes.set(node.id, {
          ...node,
          branch_ids: [...node.branch_ids, branch.id],
        });
      }
    }
    this.emit("conversation", session.graph_id, "conversation.branch.created", {
      branch,
      shared_node_ids: shared.map((node) => node.id),
    });
    return { branch };
  }

  /* ── 通知 ── */

  private raiseNotification(
    severity: NotificationSeverity,
    message: string,
    sourceWorkbench: NotificationSourceWorkbench,
    sourceNodeId: string | null,
  ): string {
    const notification: Notification = {
      id: `ntf-${this.idPrefix}-${++this.notificationCounter}`,
      severity,
      message,
      source_workbench: sourceWorkbench,
      source_node_id: sourceNodeId,
      lifecycle: "active",
      raised_at: now(),
      acknowledged_at: null,
      resolved_at: null,
    };
    this.notifications.set(notification.id, notification);
    this.emit("notification", notification.id, "notification.raised", {
      notification,
    });
    return notification.id;
  }

  /** 领域事实解除时关闭通知（PRD-NOTIFY-007：不靠超时猜测） */
  private resolveNotification(notificationId: string) {
    const notification = this.notifications.get(notificationId);
    if (!notification || notification.lifecycle === "resolved") return;
    const resolved_at = now();
    this.notifications.set(notificationId, {
      ...notification,
      lifecycle: "resolved",
      resolved_at,
    });
    this.emit("notification", notificationId, "notification.resolved", {
      notification_id: notificationId,
      resolved_at,
    });
  }

  /** 启动后 10–30 秒陆续产生不同 severity 的模拟通知（幂等） */
  private startDemoNotifications() {
    if (import.meta.env.VITE_ENABLE_DEMO_NOTIFICATIONS !== "true") return;
    if (this.demoNotificationsStarted) return;
    this.demoNotificationsStarted = true;
    const schedule = (delayMs: number, raise: () => void) => {
      const timer = setTimeout(raise, delayMs);
      if (typeof timer.unref === "function") timer.unref();
    };
    schedule(10_000, () =>
      this.raiseNotification(
        "info",
        "演示事件流已连接，GrayDango 通知队列就绪。",
        "system",
        null,
      ),
    );
    schedule(16_000, () =>
      this.raiseNotification(
        "warning",
        "演示：模型目录需要重新验证凭据。",
        "settings",
        null,
      ),
    );
    schedule(23_000, () =>
      this.raiseNotification(
        "action_required",
        "演示：检测到未提交变更，启动 Run 前需要确认处理方式。",
        "git",
        null,
      ),
    );
    schedule(30_000, () =>
      this.raiseNotification(
        "error",
        "演示：终端会话 t-1 意外断开（可重连）。",
        "terminal",
        "t-1",
      ),
    );
  }

  async acknowledgeNotification(notification_id: string): Promise<void> {
    await latency();
    const notification = this.notifications.get(notification_id);
    if (!notification || notification.lifecycle !== "active") return;
    const acknowledged_at = now();
    this.notifications.set(notification_id, {
      ...notification,
      lifecycle: "acknowledged",
      acknowledged_at,
    });
    this.emit("notification", notification_id, "notification.acknowledged", {
      notification_id,
      acknowledged_at,
    });
  }

  /* ── 工作台概览 ── */

  getWorkbenchSummary(kind: WorkbenchKind): Promise<WorkbenchSummary> {
    const lines: Record<WorkbenchKind, () => string[]> = {
      delivery: () => this.delivery.summaryLines(),
      files: () => this.files.summaryLines(),
      git: () => this.git.summaryLines(),
      terminal: () => this.terminal.summaryLines(),
      usage: () => this.usage.summaryLines(),
      settings: () => this.settings.summaryLines(),
    };
    return latency().then(() => ({
      kind,
      title: WORKBENCH_TITLES[kind],
      lines: lines[kind](),
    }));
  }

  /* ── 需求交付命令（委托 DeliveryModule） ── */

  createRequirementFromChat(input: {
    session_id: string;
    branch_id: string;
    node_ids: string[];
    title?: string;
  }): Promise<{ requirement_id: string }> {
    return this.delivery.createRequirementFromChat(input);
  }

  answerClarification(input: {
    requirement_id: string;
    round_id: string;
    answer: ClarificationAnswer;
  }): Promise<void> {
    return this.delivery.answerClarification(input);
  }

  cancelRequirement(requirementId: string): Promise<void> {
    return this.delivery.cancelRequirement(requirementId);
  }

  updateSpec(input: {
    requirement_id: string;
    base_revision: number;
    spec: RequirementSpec;
  }): Promise<{ revision: number; conflict: boolean }> {
    return this.delivery.updateSpec(input);
  }

  confirmRequirement(input: {
    requirement_id: string;
    revision: number;
    task_budget_usd: number;
  }): Promise<{ run_id: string | null; conflict: boolean }> {
    return this.delivery.confirmRequirement(input);
  }

  getConfirmationPreview(requirementId: string): Promise<ConfirmationPreview> {
    return this.delivery.getConfirmationPreview(requirementId);
  }

  reorderQueue(input: { requirement_ids: string[] }): Promise<{ ok: boolean }> {
    return this.delivery.reorderQueue(input);
  }

  pauseRun(runId: string): Promise<void> {
    return this.delivery.pauseRun(runId);
  }

  resumeRun(runId: string): Promise<void> {
    return this.delivery.resumeRun(runId);
  }

  retryRun(runId: string): Promise<void> {
    return this.delivery.retryRun(runId);
  }

  updateWorkItem(input: {
    run_id: string;
    item_id: string;
    patch: Partial<
      Pick<WorkItem, "title" | "scenario_ids" | "verification_target">
    >;
  }): Promise<{ plan_revision: number }> {
    return this.delivery.updateWorkItem(input);
  }

  requestAction(input: {
    kind: PendingActionKind;
    run_id: string;
  }): Promise<{ action_id: string }> {
    return this.delivery.requestAction(input);
  }

  confirmAction(actionId: string): Promise<void> {
    return this.delivery.confirmAction(actionId);
  }

  cancelAction(actionId: string): Promise<void> {
    return this.delivery.cancelAction(actionId);
  }

  getScenarioState(): Promise<ScenarioState> {
    return this.delivery.getScenarioState();
  }

  scenarioControl(command: ScenarioCommand): Promise<ScenarioState> {
    return this.delivery.scenarioControl(command);
  }

  /* ── 文件命令（委托 FilesModule） ── */

  listDirectory(path: string): Promise<FileEntry[]> {
    return this.files.listDirectory(path);
  }

  searchFiles(query: string): Promise<FileSearchResult[]> {
    return this.files.search(query);
  }

  getFilePreview(path: string): Promise<FilePreview> {
    return this.files.preview(path);
  }

  /* ── Git 命令（委托 GitModule） ── */

  stageChanges(paths: string[]) {
    return this.git.stageChanges(paths);
  }

  unstageChanges(paths: string[]) {
    return this.git.unstageChanges(paths);
  }

  /* ── 工作台危险操作两阶段（prepare/confirm 语义） ── */

  async requestWorkbenchAction(input: {
    kind: WorkbenchActionKind;
    payload?: Record<string, string>;
    source_node_id?: string | null;
  }): Promise<{ action_id: string }> {
    await latency();
    const payload = input.payload ?? {};
    const copy = workbenchActionCopy(input.kind, payload);
    const action: WorkbenchAction = {
      id: `wact-${this.idPrefix}-${++this.workbenchActionCounter}`,
      kind: input.kind,
      title: copy.title,
      impact: copy.impact,
      irreversible: copy.irreversible,
      source_node_id: input.source_node_id ?? null,
      payload,
      confirm_token: `tok-${Math.random().toString(36).slice(2, 10)}`,
      state: "awaiting",
      result: null,
      created_at: now(),
      updated_at: now(),
    };
    this.workbenchActions.set(action.id, action);
    this.emit("action", action.id, "workbench_action.updated", { action });
    return { action_id: action.id };
  }

  async confirmWorkbenchAction(input: {
    action_id: string;
    confirm_token: string;
  }): Promise<void> {
    const action = this.workbenchActions.get(input.action_id);
    if (!action || action.state !== "awaiting") return;
    if (action.confirm_token !== input.confirm_token) {
      // token 过期/不匹配：拒绝执行（BE-API-004 两阶段契约）
      const rejected: WorkbenchAction = {
        ...action,
        state: "cancelled",
        result: { ok: false, message: "确认 token 不匹配，已拒绝执行。" },
        updated_at: now(),
      };
      this.workbenchActions.set(action.id, rejected);
      this.emit("action", action.id, "workbench_action.updated", {
        action: rejected,
      });
      return;
    }
    if (action.kind === "conversation_new_session") {
      const sessionId = action.payload.session_id;
      const branchId = action.payload.branch_id;
      if (sessionId && branchId) {
        this.abortResponseImmediately(sessionId, branchId);
      }
    }
    await latency();
    let result: { ok: boolean; message: string };
    if (action.kind.startsWith("git_")) {
      result = this.git.execute(action.kind, action.payload);
    } else if (action.kind === "terminal_close") {
      result = this.terminal.forceClose(action.payload.session_id);
    } else if (action.kind === "conversation_new_session") {
      const created = await this.createConversationSession({
        idempotency_key: action.id,
      });
      result = {
        ok: true,
        message: `已创建独立会话 ${created.session.id}。`,
      };
    } else {
      const nodeId = action.payload.node_id ?? action.source_node_id;
      const node = nodeId ? this.nodes.get(nodeId) : null;
      if (!node) {
        result = { ok: false, message: "来源对话节点不存在，未执行删除。" };
      } else if (node.redacted_at) {
        result = { ok: true, message: "该节点已经删除，无需重复执行。" };
      } else {
        for (const branchId of node.branch_ids) {
          this.runs.get(branchId)?.abort();
          this.runs.delete(branchId);
          this.abortActiveNodes(branchId);
        }
        const redactedAt = now();
        this.nodes.set(node.id, {
          ...node,
          content: "",
          redacted_at: redactedAt,
        });
        this.emit("conversation", node.graph_id, "conversation.node.redacted", {
          node_id: node.id,
          redacted_at: redactedAt,
        });
        result = {
          ok: true,
          message: "节点内容已删除，图结构与分支关系保留。",
        };
      }
    }
    const confirmed: WorkbenchAction = {
      ...action,
      state: "confirmed",
      result,
      updated_at: now(),
    };
    this.workbenchActions.set(action.id, confirmed);
    this.emit("action", action.id, "workbench_action.updated", {
      action: confirmed,
    });
  }

  async cancelWorkbenchAction(actionId: string): Promise<void> {
    await latency();
    const action = this.workbenchActions.get(actionId);
    if (!action || action.state !== "awaiting") return;
    const cancelled: WorkbenchAction = {
      ...action,
      state: "cancelled",
      result: { ok: true, message: "已取消，未执行任何变更。" },
      updated_at: now(),
    };
    this.workbenchActions.set(actionId, cancelled);
    this.emit("action", actionId, "workbench_action.updated", {
      action: cancelled,
    });
  }

  /* ── 终端命令（委托 TerminalModule） ── */

  createTerminal(): Promise<{ session_id: string }> {
    return this.terminal.create();
  }

  renameTerminal(input: { session_id: string; title: string }): Promise<void> {
    return this.terminal.rename(input);
  }

  closeTerminal(sessionId: string): Promise<void> {
    return this.terminal.close(sessionId);
  }

  async terminalInput(input: {
    session_id: string;
    data: string;
  }): Promise<void> {
    this.terminal.input(input);
  }

  async resizeTerminal(input: {
    session_id: string;
    cols: number;
    rows: number;
  }): Promise<void> {
    this.terminal.resize(input);
  }

  disconnectTerminal(sessionId: string): Promise<void> {
    return this.terminal.disconnect(sessionId);
  }

  reconnectTerminal(sessionId: string): Promise<void> {
    return this.terminal.reconnect(sessionId);
  }

  subscribeTerminalOutput(
    sessionId: string,
    onData: (data: string) => void,
  ): () => void {
    return this.terminal.subscribeOutput(sessionId, onData);
  }

  /* ── 模型配置命令（设置工作台，委托 ModelsModule） ── */

  setProviderCredential(input: {
    provider_id: string;
    secret: string;
  }): Promise<void> {
    return this.models.setProviderCredential(input);
  }

  assignRoleModel(input: {
    role: ModelRole;
    slot: "primary" | "fallback";
    model: ModelRef | null;
  }) {
    return this.models.assignRoleModel(input);
  }

  /* ── 设置命令（委托 SettingsModule） ── */

  updateSettings(patch: Partial<AppSettings>): Promise<void> {
    return this.settings.update(patch);
  }

  restartSystem(): Promise<void> {
    return this.settings.restart();
  }

  getDiagnostics(): Promise<DiagnosticsInfo> {
    return this.settings.diagnostics();
  }
}
