import { create } from "zustand";
import type {
  AppSettings,
  ApplicationSnapshot,
  ClarificationRound,
  ConversationGraphSnapshot,
  ConversationSession,
  DomainEventPayload,
  EventEnvelope,
  EventType,
  GitRepoState,
  Notification,
  PendingAction,
  ProviderInfo,
  Publication,
  Requirement,
  RequirementRevision,
  RoleAssignResult,
  RoleProfile,
  Run,
  RunReview,
  RunValidation,
  TerminalSession,
  UsageState,
  WorkbenchAction,
  WorkPlan,
} from "../api/types";
import type { EventConnectionState } from "../events/connect";
import {
  createGraphState,
  reduceBranchCreated,
  reduceNodeCreated,
  reduceNodeDelta,
  reduceNodeRedacted,
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
  activeConversationSessionId: string;
  conversationSessions: Record<string, ConversationSession>;
  conversationGraphs: Record<string, ConversationGraphState>;
  /** 最近创建且尚未终止的持久对话节点，用于创建事件到活动状态之间的相机跟随。 */
  recentConversationNodeId: string | null;
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
  /** 普通工作台危险操作的来源内确认/结果条事实（git/terminal）。 */
  workbenchActions: Record<string, WorkbenchAction>;
  git: GitRepoState | null;
  terminals: Record<string, TerminalSession>;
  providers: ProviderInfo[];
  roles: RoleProfile[];
  usage: UsageState | null;
  /** 模型角色保存结果（能力不匹配时在角色来源区显示） */
  modelResult: RoleAssignResult;
  settings: AppSettings | null;

  initFromSnapshot: (snapshot: ApplicationSnapshot) => void;
  applyEvent: (envelope: EventEnvelope) => void;
  setConnection: (state: EventConnectionState) => void;
};

type Projection = Pick<
  DomainState,
  | "activeConversationSessionId"
  | "conversationSessions"
  | "conversationGraphs"
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

type ReducerProjection = Projection & {
  conversation: ConversationGraphState;
};

/** event_type → 类型化 reducer 集中注册表 */

const MAX_CONVERSATION_GRAPHS = 10;
const EMPTY_CONVERSATION = createGraphState("g-main", "b-main");

export const selectActiveConversation = (
  state: Pick<
    DomainState,
    "activeConversationSessionId" | "conversationGraphs"
  >,
): ConversationGraphState =>
  state.conversationGraphs[state.activeConversationSessionId] ??
  EMPTY_CONVERSATION;

function graphActivity(graph: ConversationGraphState): string {
  return Object.values(graph.nodes).reduce(
    (latest, node) =>
      node.created_at.localeCompare(latest) > 0 ? node.created_at : latest,
    "",
  );
}

function trimConversationGraphs(
  graphs: Record<string, ConversationGraphState>,
  activeSessionId: string,
): Record<string, ConversationGraphState> {
  if (Object.keys(graphs).length <= MAX_CONVERSATION_GRAPHS) return graphs;
  const kept = Object.entries(graphs)
    .filter(([sessionId]) => sessionId !== activeSessionId)
    .sort(([, left], [, right]) =>
      graphActivity(right).localeCompare(graphActivity(left)),
    )
    .slice(0, MAX_CONVERSATION_GRAPHS - 1);
  return Object.fromEntries([
    [activeSessionId, graphs[activeSessionId]],
    ...kept,
  ]);
}

const eventReducers: {
  [K in EventType]: (
    state: ReducerProjection,
    payload: EventEnvelope<K>["payload"],
  ) => Partial<ReducerProjection>;
} = {
  "conversation.session.created": (state, { session, graph }) => {
    const conversation = graphFromGraphSnapshot(graph);
    const graphs: Record<string, ConversationGraphState> = {
      ...state.conversationGraphs,
      [session.id]: conversation,
    };
    return {
      activeConversationSessionId: session.id,
      conversationSessions: {
        ...state.conversationSessions,
        [session.id]: session,
      },
      conversationGraphs: trimConversationGraphs(graphs, session.id),
    };
  },
  "conversation.node.created": (state, { node }) => ({
    conversation: reduceNodeCreated(state.conversation, node),
  }),
  "conversation.node.delta": (state, payload) => ({
    conversation: reduceNodeDelta(state.conversation, payload),
  }),
  "conversation.node.state_changed": (state, payload) => ({
    conversation: reduceNodeStateChanged(state.conversation, payload),
  }),
  "conversation.node.redacted": (state, payload) => ({
    conversation: reduceNodeRedacted(state.conversation, payload),
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
  "requirement.clarification_cancelled": (state, { round }) => ({
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
    modelResult: payload.last_result,
  }),
  "usage.updated": (_state, { usage }) => ({ usage }),
  "settings.updated": (_state, { settings }) => ({ settings }),
  "system.resync_required": () => ({}), // 由事件连接层处理，不进入领域投影
};

function graphFromGraphSnapshot(
  graphSnapshot: ConversationGraphSnapshot,
): ConversationGraphState {
  const { graph_id, root_branch_id, nodes, branches } = graphSnapshot;
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
  activeConversationSessionId: "s-main",
  conversationSessions: {},
  conversationGraphs: {},
  recentConversationNodeId: null,
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
    set(() => {
      const sessions = indexBy(
        snapshot.state.conversation.sessions,
        (session) => session.id,
      );
      const graphs = Object.fromEntries(
        snapshot.state.conversation.sessions.map((session) => {
          const graph = snapshot.state.conversation.graphs.find(
            (candidate) => candidate.graph_id === session.graph_id,
          );
          return [
            session.id,
            graph
              ? graphFromGraphSnapshot(graph)
              : createGraphState(session.graph_id, session.root_branch_id),
          ];
        }),
      );
      const activeId = snapshot.state.conversation.active_session_id;
      return {
        snapshotLoaded: true,
        lastSequence: snapshot.last_sequence,
        activeConversationSessionId: activeId,
        conversationSessions: sessions,
        conversationGraphs: graphs,
        recentConversationNodeId: null,
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
        workbenchActions: indexBy(
          snapshot.state.workbench_actions,
          (a) => a.id,
        ),
        git: snapshot.state.git,
        terminals: indexBy(snapshot.state.terminals, (t) => t.id),
        providers: snapshot.state.models.providers,
        roles: snapshot.state.models.roles,
        usage: snapshot.state.usage,
        modelResult: snapshot.state.models.last_result,
        settings: snapshot.state.settings,
      };
    }),

  applyEvent: (envelope) =>
    set((state) => {
      const reducer = eventReducers[envelope.event_type] as (
        state: ReducerProjection,
        payload: EventEnvelope["payload"],
      ) => Partial<ReducerProjection>;
      if (!reducer) return state; // 未知扩展事件：忽略但不崩溃（FE-EVENT-007）
      const graphEventSessionId =
        envelope.aggregate_type === "conversation" &&
        envelope.event_type !== "conversation.session.created"
          ? Object.values(state.conversationSessions).find(
              (session) => session.graph_id === envelope.aggregate_id,
            )?.id
          : undefined;
      const targetSessionId =
        graphEventSessionId ?? state.activeConversationSessionId;
      const session = state.conversationSessions[targetSessionId];
      const projection: ReducerProjection = {
        conversation:
          state.conversationGraphs[targetSessionId] ??
          createGraphState(
            session?.graph_id ?? envelope.aggregate_id,
            session?.root_branch_id ?? "b-main",
          ),
        activeConversationSessionId: state.activeConversationSessionId,
        conversationSessions: state.conversationSessions,
        conversationGraphs: state.conversationGraphs,
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
      const reducerPatch = reducer(projection, envelope.payload);
      const { conversation: updatedConversation, ...projectionPatch } =
        reducerPatch;
      let patch: Partial<Projection> = projectionPatch;
      if (
        updatedConversation &&
        envelope.event_type !== "conversation.session.created"
      ) {
        patch = {
          ...patch,
          conversationGraphs: trimConversationGraphs(
            {
              ...state.conversationGraphs,
              [targetSessionId]: updatedConversation,
            },
            state.activeConversationSessionId,
          ),
        };
      }
      let recentConversationNodeId = state.recentConversationNodeId;
      if (
        envelope.event_type === "conversation.node.created" &&
        targetSessionId === state.activeConversationSessionId
      ) {
        const payload =
          envelope.payload as DomainEventPayload["conversation.node.created"];
        recentConversationNodeId = payload.node.id;
      } else if (envelope.event_type === "conversation.session.created") {
        recentConversationNodeId = null;
      } else if (
        envelope.event_type === "conversation.node.state_changed" &&
        targetSessionId === state.activeConversationSessionId
      ) {
        const payload =
          envelope.payload as DomainEventPayload["conversation.node.state_changed"];
        if (
          payload.node_id === recentConversationNodeId &&
          payload.state !== "streaming" &&
          payload.state !== "running"
        ) {
          recentConversationNodeId = null;
        }
      } else if (envelope.event_type === "requirement.updated") {
        const payload =
          envelope.payload as DomainEventPayload["requirement.updated"];
        if (
          payload.requirement.state === "queued" ||
          payload.requirement.state === "cancelled" ||
          payload.requirement.state === "superseded"
        ) {
          recentConversationNodeId = null;
        }
      }
      return {
        ...patch,
        recentConversationNodeId,
        lastSequence: Math.max(state.lastSequence, envelope.sequence),
      };
    }),

  setConnection: (connection) => set({ connection }),
}));
