import { create } from "zustand";
import { getApi } from "../api";
import type { SendMessageInput } from "../api/client";
import type {
  AppSettings,
  ApplicationSnapshot,
  ClarificationRound,
  EventEnvelope,
  EventType,
  GitRepoState,
  ModelRef,
  ModelRole,
  Notification,
  PendingAction,
  PendingActionKind,
  ProviderInfo,
  Publication,
  Requirement,
  RequirementRevision,
  RequirementSpec,
  RoleAssignResult,
  RoleProfile,
  Run,
  RunReview,
  RunValidation,
  TerminalSession,
  UsageState,
  WorkbenchAction,
  WorkbenchActionKind,
  WorkItem,
  WorkPlan,
} from "../api/types";
import type { EventConnectionState } from "../events/connect";
import {
  createGraphState,
  reduceBranchCreated,
  reduceNodeCreated,
  reduceNodeDelta,
  reduceNodeStateChanged,
  type ConversationGraphState,
} from "../chat/dag";

/**
 * 领域投影 store（02 §9.1）：只存 reducer 投影；事件由 event_type
 * 到类型化 reducer 集中注册；mutation 走命令接口，不做盲目乐观更新。
 */
export type DomainState = {
  snapshotLoaded: boolean;
  lastSequence: number;
  connection: EventConnectionState;
  conversation: ConversationGraphState;
  notifications: Record<string, Notification>;
  requirements: Record<string, Requirement>;
  clarifications: Record<string, ClarificationRound>;
  /** requirement_id → revision 链（保存即新 revision，PRD-SPEC-005） */
  revisions: Record<string, RequirementRevision[]>;
  runs: Record<string, Run>;
  /** run_id → WorkPlan（暂停编辑生成新 plan revision，整体替换） */
  plans: Record<string, WorkPlan>;
  validations: Record<string, RunValidation>;
  reviews: Record<string, RunReview>;
  publications: Record<string, Publication>;
  /** 危险操作确认链事实（FE-CANVAS-019） */
  actions: Record<string, PendingAction>;
  /** 工作台危险操作确认链（git/terminal） */
  workbenchActions: Record<string, WorkbenchAction>;
  git: GitRepoState | null;
  terminals: Record<string, TerminalSession>;
  providers: ProviderInfo[];
  roles: RoleProfile[];
  usage: UsageState | null;
  /** 模型角色保存结果（能力不匹配被阻止的结果节点，FE-MODEL-002） */
  modelResult: RoleAssignResult;
  settings: AppSettings | null;

  initFromSnapshot: (snapshot: ApplicationSnapshot) => void;
  applyEvent: (envelope: EventEnvelope) => void;
  setConnection: (state: EventConnectionState) => void;

  sendMessage: (input: SendMessageInput) => Promise<void>;
  abortResponse: (branchId: string) => Promise<void>;
  branchFromNode: (nodeId: string) => Promise<string | null>;
  acknowledgeNotification: (notificationId: string) => Promise<void>;

  /* ── 需求交付命令 ── */
  createRequirementFromChat: (input: {
    branch_id: string;
    node_ids: string[];
    title?: string;
  }) => Promise<string>;
  answerClarification: (input: {
    requirement_id: string;
    round_id: string;
    answer: string;
  }) => Promise<void>;
  updateSpec: (input: {
    requirement_id: string;
    base_revision: number;
    spec: RequirementSpec;
  }) => Promise<{ revision: number; conflict: boolean }>;
  confirmRequirement: (input: {
    requirement_id: string;
    revision: number;
  }) => Promise<{ run_id: string | null; conflict: boolean }>;
  reorderQueue: (requirementIds: string[]) => Promise<{ ok: boolean }>;
  pauseRun: (runId: string) => Promise<void>;
  resumeRun: (runId: string) => Promise<void>;
  retryRun: (runId: string) => Promise<void>;
  updateWorkItem: (input: {
    run_id: string;
    item_id: string;
    patch: Partial<
      Pick<WorkItem, "title" | "scenario_ids" | "verification_target">
    >;
  }) => Promise<{ plan_revision: number }>;
  requestAction: (input: {
    kind: PendingActionKind;
    run_id: string;
  }) => Promise<string>;
  confirmAction: (actionId: string) => Promise<void>;
  cancelAction: (actionId: string) => Promise<void>;

  /* ── P3 工作台命令 ── */
  stageChange: (
    path: string,
  ) => Promise<{ ok: boolean; message: string | null }>;
  unstageChange: (
    path: string,
  ) => Promise<{ ok: boolean; message: string | null }>;
  requestWorkbenchAction: (input: {
    kind: WorkbenchActionKind;
    payload?: Record<string, string>;
    source_node_id?: string | null;
  }) => Promise<string>;
  confirmWorkbenchAction: (action: WorkbenchAction) => Promise<void>;
  cancelWorkbenchAction: (actionId: string) => Promise<void>;
  createTerminal: () => Promise<string>;
  renameTerminal: (input: {
    session_id: string;
    title: string;
  }) => Promise<void>;
  closeTerminal: (sessionId: string) => Promise<void>;
  disconnectTerminal: (sessionId: string) => Promise<void>;
  reconnectTerminal: (sessionId: string) => Promise<void>;
  setProviderCredential: (input: {
    provider_id: string;
    secret: string;
  }) => Promise<void>;
  assignRoleModel: (input: {
    role: ModelRole;
    slot: "primary" | "fallback";
    model: ModelRef | null;
  }) => Promise<{ ok: boolean; message: string }>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  restartSystem: () => Promise<void>;
};

type Projection = Pick<
  DomainState,
  | "conversation"
  | "notifications"
  | "requirements"
  | "clarifications"
  | "revisions"
  | "runs"
  | "plans"
  | "validations"
  | "reviews"
  | "publications"
  | "actions"
  | "workbenchActions"
  | "git"
  | "terminals"
  | "providers"
  | "roles"
  | "usage"
  | "modelResult"
  | "settings"
  | "lastSequence"
>;

/** event_type → 类型化 reducer 集中注册表 */
const eventReducers: {
  [K in EventType]: (
    state: Projection,
    payload: EventEnvelope<K>["payload"],
  ) => Partial<Projection>;
} = {
  "conversation.node.created": (state, { node }) => ({
    conversation: reduceNodeCreated(state.conversation, node),
  }),
  "conversation.node.delta": (state, payload) => ({
    conversation: reduceNodeDelta(state.conversation, payload),
  }),
  "conversation.node.state_changed": (state, payload) => ({
    conversation: reduceNodeStateChanged(state.conversation, payload),
  }),
  "conversation.branch.created": (state, payload) => ({
    conversation: reduceBranchCreated(state.conversation, payload),
  }),
  "notification.raised": (state, { notification }) => ({
    notifications: { ...state.notifications, [notification.id]: notification },
  }),
  "notification.acknowledged": (
    state,
    { notification_id, acknowledged_at },
  ) => {
    const notification = state.notifications[notification_id];
    if (!notification) return {};
    return {
      notifications: {
        ...state.notifications,
        [notification_id]: {
          ...notification,
          lifecycle: "acknowledged",
          acknowledged_at,
        },
      },
    };
  },
  "notification.resolved": (state, { notification_id, resolved_at }) => {
    const notification = state.notifications[notification_id];
    if (!notification) return {};
    return {
      notifications: {
        ...state.notifications,
        [notification_id]: {
          ...notification,
          lifecycle: "resolved",
          resolved_at,
        },
      },
    };
  },
  "requirement.created": (state, { requirement }) => ({
    requirements: { ...state.requirements, [requirement.id]: requirement },
  }),
  "requirement.updated": (state, { requirement }) => ({
    requirements: { ...state.requirements, [requirement.id]: requirement },
  }),
  "requirement.clarification_asked": (state, { round }) => ({
    clarifications: { ...state.clarifications, [round.id]: round },
  }),
  "requirement.clarification_answered": (state, { round }) => ({
    clarifications: { ...state.clarifications, [round.id]: round },
  }),
  "requirement.revision_created": (state, { revision }) => {
    const list = state.revisions[revision.requirement_id] ?? [];
    const index = list.findIndex(
      (entry) => entry.revision === revision.revision,
    );
    const next =
      index >= 0
        ? list.map((entry, i) => (i === index ? revision : entry))
        : [...list, revision];
    return {
      revisions: { ...state.revisions, [revision.requirement_id]: next },
    };
  },
  // 顺序由 requirement.updated 的 queue_position 承载，此处无需额外投影
  "requirement.queue_reordered": () => ({}),
  "run.updated": (state, { run }) => ({
    runs: { ...state.runs, [run.id]: run },
  }),
  "plan.updated": (state, { plan }) => ({
    plans: { ...state.plans, [plan.run_id]: plan },
  }),
  "validation.updated": (state, { validation }) => ({
    validations: { ...state.validations, [validation.run_id]: validation },
  }),
  "review.updated": (state, { review }) => ({
    reviews: { ...state.reviews, [review.run_id]: review },
  }),
  "publication.updated": (state, { publication }) => ({
    publications: { ...state.publications, [publication.run_id]: publication },
  }),
  "action.updated": (state, { action }) => ({
    actions: { ...state.actions, [action.id]: action },
  }),
  "workbench_action.updated": (state, { action }) => ({
    workbenchActions: { ...state.workbenchActions, [action.id]: action },
  }),
  "git.updated": (_state, payload) => ({ git: payload.state }),
  "terminal.session_updated": (state, { session, closed }) => {
    if (closed) {
      const terminals = { ...state.terminals };
      delete terminals[session.id];
      return { terminals };
    }
    return { terminals: { ...state.terminals, [session.id]: session } };
  },
  "models.updated": (_state, payload) => ({
    providers: payload.providers,
    roles: payload.roles,
    usage: payload.usage,
    modelResult: payload.last_result,
  }),
  "settings.updated": (_state, { settings }) => ({ settings }),
  "system.resync_required": () => ({}), // 由事件连接层处理，不进入领域投影
};

function graphFromSnapshot(
  snapshot: ApplicationSnapshot,
): ConversationGraphState {
  const { graph_id, root_branch_id, nodes, branches } =
    snapshot.state.conversation;
  let graph = createGraphState(graph_id, root_branch_id);
  for (const node of [...nodes].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  )) {
    graph = reduceNodeCreated(graph, node);
  }
  for (const branch of branches) {
    if (branch.id === root_branch_id) {
      graph = {
        ...graph,
        branches: { ...graph.branches, [branch.id]: branch },
      };
      continue;
    }
    const shared = Object.values(graph.nodes)
      .filter((node) => node.branch_ids.includes(branch.id))
      .map((node) => node.id);
    graph = reduceBranchCreated(graph, { branch, shared_node_ids: shared });
  }
  return graph;
}

/** revision 链归并：同一 revision 后者覆盖前者（确认事实写回） */
function groupRevisions(
  revisions: RequirementRevision[],
): Record<string, RequirementRevision[]> {
  const grouped: Record<string, RequirementRevision[]> = {};
  for (const revision of revisions) {
    const list = grouped[revision.requirement_id] ?? [];
    const index = list.findIndex(
      (entry) => entry.revision === revision.revision,
    );
    grouped[revision.requirement_id] =
      index >= 0
        ? list.map((entry, i) => (i === index ? revision : entry))
        : [...list, revision];
  }
  return grouped;
}

const indexBy = <T>(list: T[], key: (item: T) => string): Record<string, T> =>
  Object.fromEntries(list.map((item) => [key(item), item]));

export const useDomainStore = create<DomainState>()((set) => ({
  snapshotLoaded: false,
  lastSequence: 0,
  connection: "connecting",
  conversation: createGraphState("g-main", "b-main"),
  notifications: {},
  requirements: {},
  clarifications: {},
  revisions: {},
  runs: {},
  plans: {},
  validations: {},
  reviews: {},
  publications: {},
  actions: {},
  workbenchActions: {},
  git: null,
  terminals: {},
  providers: [],
  roles: [],
  usage: null,
  modelResult: null,
  settings: null,

  initFromSnapshot: (snapshot) =>
    set(() => ({
      snapshotLoaded: true,
      lastSequence: snapshot.last_sequence,
      conversation: graphFromSnapshot(snapshot),
      notifications: indexBy(snapshot.state.notifications, (n) => n.id),
      requirements: indexBy(snapshot.state.requirements, (r) => r.id),
      clarifications: indexBy(snapshot.state.clarifications, (c) => c.id),
      revisions: groupRevisions(snapshot.state.revisions),
      runs: indexBy(snapshot.state.runs, (r) => r.id),
      plans: indexBy(snapshot.state.plans, (p) => p.run_id),
      validations: indexBy(snapshot.state.validations, (v) => v.run_id),
      reviews: indexBy(snapshot.state.reviews, (r) => r.run_id),
      publications: indexBy(snapshot.state.publications, (p) => p.run_id),
      actions: indexBy(snapshot.state.actions, (a) => a.id),
      workbenchActions: indexBy(snapshot.state.workbench_actions, (a) => a.id),
      git: snapshot.state.git,
      terminals: indexBy(snapshot.state.terminals, (t) => t.id),
      providers: snapshot.state.models.providers,
      roles: snapshot.state.models.roles,
      usage: snapshot.state.models.usage,
      modelResult: snapshot.state.models.last_result,
      settings: snapshot.state.settings,
    })),

  applyEvent: (envelope) =>
    set((state) => {
      const reducer = eventReducers[envelope.event_type] as (
        state: Projection,
        payload: EventEnvelope["payload"],
      ) => Partial<Projection>;
      if (!reducer) return state; // 未知扩展事件：忽略但不崩溃（FE-EVENT-007）
      const projection: Projection = {
        conversation: state.conversation,
        notifications: state.notifications,
        requirements: state.requirements,
        clarifications: state.clarifications,
        revisions: state.revisions,
        runs: state.runs,
        plans: state.plans,
        validations: state.validations,
        reviews: state.reviews,
        publications: state.publications,
        actions: state.actions,
        workbenchActions: state.workbenchActions,
        git: state.git,
        terminals: state.terminals,
        providers: state.providers,
        roles: state.roles,
        usage: state.usage,
        modelResult: state.modelResult,
        settings: state.settings,
        lastSequence: state.lastSequence,
      };
      const patch = reducer(projection, envelope.payload);
      return {
        ...state,
        ...patch,
        lastSequence: Math.max(state.lastSequence, envelope.sequence),
      };
    }),

  setConnection: (connection) => set((state) => ({ ...state, connection })),

  sendMessage: async (input) => {
    await getApi().sendMessage(input);
  },

  abortResponse: async (branchId) => {
    await getApi().abortResponse(branchId);
  },

  branchFromNode: async (nodeId) => {
    const { branch } = await getApi().branchFrom({ node_id: nodeId });
    return branch.id;
  },

  acknowledgeNotification: async (notificationId) => {
    await getApi().acknowledgeNotification(notificationId);
  },

  createRequirementFromChat: async (input) => {
    const { requirement_id } = await getApi().createRequirementFromChat(input);
    return requirement_id;
  },

  answerClarification: async (input) => {
    await getApi().answerClarification(input);
  },

  updateSpec: (input) => getApi().updateSpec(input),

  confirmRequirement: (input) => getApi().confirmRequirement(input),

  reorderQueue: (requirementIds) =>
    getApi().reorderQueue({ requirement_ids: requirementIds }),

  pauseRun: async (runId) => {
    await getApi().pauseRun(runId);
  },

  resumeRun: async (runId) => {
    await getApi().resumeRun(runId);
  },

  retryRun: async (runId) => {
    await getApi().retryRun(runId);
  },

  updateWorkItem: (input) => getApi().updateWorkItem(input),

  requestAction: async (input) => {
    const { action_id } = await getApi().requestAction(input);
    return action_id;
  },

  confirmAction: async (actionId) => {
    await getApi().confirmAction(actionId);
  },

  cancelAction: async (actionId) => {
    await getApi().cancelAction(actionId);
  },

  /* ── P3 工作台命令 ── */

  stageChange: (path) => getApi().stageChange(path),

  unstageChange: (path) => getApi().unstageChange(path),

  requestWorkbenchAction: async (input) => {
    const { action_id } = await getApi().requestWorkbenchAction(input);
    return action_id;
  },

  confirmWorkbenchAction: async (action) => {
    await getApi().confirmWorkbenchAction({
      action_id: action.id,
      confirm_token: action.confirm_token,
    });
  },

  cancelWorkbenchAction: async (actionId) => {
    await getApi().cancelWorkbenchAction(actionId);
  },

  createTerminal: async () => {
    const { session_id } = await getApi().createTerminal();
    return session_id;
  },

  renameTerminal: async (input) => {
    await getApi().renameTerminal(input);
  },

  closeTerminal: async (sessionId) => {
    await getApi().closeTerminal(sessionId);
  },

  disconnectTerminal: async (sessionId) => {
    await getApi().disconnectTerminal(sessionId);
  },

  reconnectTerminal: async (sessionId) => {
    await getApi().reconnectTerminal(sessionId);
  },

  setProviderCredential: async (input) => {
    await getApi().setProviderCredential(input);
  },

  assignRoleModel: (input) => getApi().assignRoleModel(input),

  updateSettings: async (patch) => {
    await getApi().updateSettings(patch);
  },

  restartSystem: async () => {
    await getApi().restartSystem();
  },
}));
