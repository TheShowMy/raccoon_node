import type {
  ClarificationRound,
  ConversationBranch,
  ConversationNode,
  ConversationNodeState,
  Requirement,
} from "../api/types";

/**
 * 中央对话 DAG 的客户端投影（纯函数，便于测试）。
 * 事件 reducer 只追加/更新事实：node.delta 按 node_id + node_sequence 有序去重，
 * branchFrom 共享祖先且原分支不可改写，ProcessGroup 是可逆展示投影（不删原节点）。
 */

export type Point = { x: number; y: number };
export type NodeSize = { width: number; height: number };

/**
 * 对话节点布局几何：位置是 UI 投影，不进入领域事件。
 * 相邻节点使用外框等距布局，不能再以固定中心点槽位推断高度。
 */
export const CHAT_NODE_WIDTH = 320;
export const CHAT_NODE_GAP = 48;
export const CHAT_BRANCH_OFFSET_X = CHAT_NODE_WIDTH + CHAT_NODE_GAP;
const CHAT_NODE_ORDER_STEP = 1;

export type ConversationGraphState = {
  graph_id: string;
  root_branch_id: string;
  nodes: Record<string, ConversationNode>;
  branches: Record<string, ConversationBranch>;
  /** node_id → 布局位置（创建时确定，之后不推移已完成节点） */
  positions: Record<string, Point>;
  /** branch_id → 分支末端节点 id（空串表示分支尚无节点） */
  heads: Record<string, string>;
  /** branch_id → 错层车道序号（同锚点兄弟分支依次外扩） */
  branchLanes: Record<string, number>;
};

export function createGraphState(
  graph_id: string,
  root_branch_id: string,
): ConversationGraphState {
  return {
    graph_id,
    root_branch_id,
    nodes: {},
    branches: {},
    positions: {},
    heads: { [root_branch_id]: "" },
    branchLanes: { [root_branch_id]: 0 },
  };
}

const isActiveState = (state: ConversationNodeState) =>
  state === "streaming" || state === "running";

const replaceNode = (
  state: ConversationGraphState,
  node: ConversationNode,
): ConversationGraphState => ({
  ...state,
  nodes: { ...state.nodes, [node.id]: node },
});

/** 父节点是否为本分支独占（共享祖先归一到父分支车道，不重复叠加错层偏移） */
function isExclusiveToBranch(
  state: ConversationGraphState,
  nodeId: string,
  branchId: string,
): boolean {
  const node = state.nodes[nodeId];
  return (
    !!node && node.branch_ids.length === 1 && node.branch_ids[0] === branchId
  );
}

/** 节点在其分支内的直接前驱位置 */
function positionForNewNode(
  state: ConversationGraphState,
  node: ConversationNode,
): Point {
  const parentId = node.parent_ids[node.parent_ids.length - 1];
  const parentPos = parentId ? state.positions[parentId] : undefined;
  const branchId = node.branch_ids[node.branch_ids.length - 1];
  if (!parentPos) return { x: 0, y: 0 };
  const lane =
    parentId && isExclusiveToBranch(state, parentId, branchId)
      ? 0
      : (state.branchLanes[branchId] ?? 0);
  return {
    x: parentPos.x + lane * CHAT_BRANCH_OFFSET_X,
    y: parentPos.y + CHAT_NODE_ORDER_STEP,
  };
}

export function reduceNodeCreated(
  state: ConversationGraphState,
  node: ConversationNode,
): ConversationGraphState {
  if (state.nodes[node.id]) return state;
  const position = positionForNewNode(state, node);
  const heads = { ...state.heads };
  // 末端推进：新节点的父节点是某分支当前末端时，该分支末端前进到新节点
  for (const branchId of node.branch_ids) {
    const head = heads[branchId] ?? "";
    if (head === "" || node.parent_ids.includes(head)) {
      heads[branchId] = node.id;
    }
  }
  return {
    ...state,
    nodes: { ...state.nodes, [node.id]: node },
    positions: { ...state.positions, [node.id]: position },
    heads,
  };
}

/** node delta：严格 node_sequence + 1 追加；小于等于去重，大于则拒绝（由流层 resync） */
export function reduceNodeDelta(
  state: ConversationGraphState,
  input: { node_id: string; node_sequence: number; delta: string },
): ConversationGraphState {
  const node = state.nodes[input.node_id];
  if (!node) return state;
  if (node.redacted_at) return state;
  if (input.node_sequence <= node.node_sequence) return state;
  if (input.node_sequence > node.node_sequence + 1) return state;
  return replaceNode(state, {
    ...node,
    content: node.content + input.delta,
    node_sequence: input.node_sequence,
  });
}

export function reduceNodeStateChanged(
  state: ConversationGraphState,
  input: {
    node_id: string;
    state: ConversationNodeState;
    completed_at?: string | null;
    tool_activity?: ConversationNode["tool_activity"];
  },
): ConversationGraphState {
  const node = state.nodes[input.node_id];
  if (!node) return state;
  return replaceNode(state, {
    ...node,
    state: input.state,
    completed_at:
      input.completed_at !== undefined ? input.completed_at : node.completed_at,
    tool_activity:
      input.tool_activity !== undefined
        ? input.tool_activity
        : node.tool_activity,
  });
}

/** redact 只清除可见正文；节点 ID、边、分支和业务引用保持不变。 */
export function reduceNodeRedacted(
  state: ConversationGraphState,
  input: { node_id: string; redacted_at: string },
): ConversationGraphState {
  const node = state.nodes[input.node_id];
  if (!node || node.redacted_at) return state;
  return replaceNode(state, {
    ...node,
    content: "",
    redacted_at: input.redacted_at,
  });
}

/** branchFrom：新分支共享根到锚点的祖先；祖先节点追加新 branch_id，内容不变 */
export function reduceBranchCreated(
  state: ConversationGraphState,
  input: { branch: ConversationBranch; shared_node_ids: string[] },
): ConversationGraphState {
  const { branch } = input;
  if (state.branches[branch.id]) return state;
  const nodes = { ...state.nodes };
  for (const id of input.shared_node_ids) {
    const node = nodes[id];
    if (!node || node.branch_ids.includes(branch.id)) continue;
    nodes[id] = { ...node, branch_ids: [...node.branch_ids, branch.id] };
  }
  // 车道：同父分支的兄弟依次外扩，保证错层（FE-CHAT-011）
  const siblingLanes = Object.values(state.branches)
    .filter((b) => b.parent_branch_id === branch.parent_branch_id)
    .map((b) => state.branchLanes[b.id] ?? 0);
  const lane = siblingLanes.length === 0 ? 1 : Math.max(...siblingLanes) + 1;
  return {
    ...state,
    nodes,
    branches: { ...state.branches, [branch.id]: branch },
    heads: { ...state.heads, [branch.id]: branch.anchor_node_id ?? "" },
    branchLanes: { ...state.branchLanes, [branch.id]: lane },
  };
}

/** 分支当前活动（streaming/running）节点 */
export function branchActiveNodes(
  state: ConversationGraphState,
  branchId: string,
): ConversationNode[] {
  return Object.values(state.nodes).filter(
    (node) => node.branch_ids.includes(branchId) && isActiveState(node.state),
  );
}

/** 沿 parent_ids 收集某节点的祖先链（含自身，根在前） */
export function ancestorChain(
  state: ConversationGraphState,
  nodeId: string,
): ConversationNode[] {
  const chain: ConversationNode[] = [];
  const visited = new Set<string>();
  let current = state.nodes[nodeId];
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.unshift(current);
    const parentId = current.parent_ids[current.parent_ids.length - 1];
    current = parentId ? state.nodes[parentId] : undefined!;
  }
  return chain;
}

/* ── 展示投影 ── */

export type BranchDisplayItem =
  | { type: "node"; node: ConversationNode; position: Point }
  | {
      type: "process_group";
      id: string;
      members: ConversationNode[];
      position: Point;
      /** 展开时组头保留，成员紧随其后，可逆折叠（FE-CHAT-010） */
      expanded: boolean;
    }
  | { type: "composer"; id: string; branchId: string; position: Point };

export type BranchDisplayItemSizes = Readonly<Record<string, NodeSize>>;
export type BranchDisplayViewport = { x: number; y: number; zoom: number };

export type BranchInputGate = {
  requirementId: string;
  kind: "clarification" | "spec_confirmation";
  targetNodeId: string | null;
};

/**
 * 一个分支只能有一个引导式需求输入所有者。门控节点接管输入期间不投影 Composer。
 * drafting 的短暂窗口可能尚无节点，此时 targetNodeId 为 null，但仍必须阻止 Composer 闪现。
 */
export function deriveBranchInputGate(
  state: ConversationGraphState,
  branchId: string,
  requirements: readonly Requirement[],
  clarifications: readonly ClarificationRound[],
): BranchInputGate | null {
  const requirement = requirements
    .filter(
      (entry) =>
        entry.source_branch_id === branchId &&
        (entry.state === "drafting" ||
          entry.state === "clarifying" ||
          entry.state === "spec_ready"),
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at))[0];
  if (!requirement) return null;

  const branchNodes = Object.values(state.nodes)
    .filter(
      (node) =>
        node.branch_ids.includes(branchId) &&
        node.requirement_id === requirement.id,
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  if (requirement.state === "spec_ready") {
    const target = branchNodes
      .filter(
        (node) =>
          node.requirement_revision === requirement.latest_revision &&
          (node.kind === "requirement_spec" ||
            node.kind === "requirement_confirmation"),
      )
      .at(-1);
    return {
      requirementId: requirement.id,
      kind: "spec_confirmation",
      targetNodeId: target?.id ?? null,
    };
  }

  const pendingRound = clarifications
    .filter(
      (round) =>
        round.requirement_id === requirement.id && round.state === "pending",
    )
    .sort((left, right) => left.asked_at.localeCompare(right.asked_at))
    .at(-1);
  const target = pendingRound
    ? branchNodes.find(
        (node) =>
          node.kind === "clarification_question" &&
          node.clarification_round_id === pendingRound.id,
      )
    : undefined;
  return {
    requirementId: requirement.id,
    kind: "clarification",
    targetNodeId: target?.id ?? null,
  };
}

export function displayItemId(item: BranchDisplayItem): string {
  switch (item.type) {
    case "node":
      return item.node.id;
    case "process_group":
    case "composer":
      return item.id;
  }
}

/** 首次 DOM 测量前的稳定估算；测量完成后会被真实外框替换。 */
export function estimatedDisplayItemSize(item: BranchDisplayItem): NodeSize {
  if (item.type === "composer") return { width: CHAT_NODE_WIDTH, height: 292 };
  if (item.type === "process_group") {
    return { width: CHAT_NODE_WIDTH, height: 132 };
  }
  switch (item.node.kind) {
    case "user_message":
      return { width: CHAT_NODE_WIDTH, height: 156 };
    case "process":
      return { width: CHAT_NODE_WIDTH, height: 148 };
    case "tool":
      return { width: CHAT_NODE_WIDTH, height: 176 };
    case "assistant_answer":
      return { width: CHAT_NODE_WIDTH, height: 196 };
    case "clarification_question":
      return { width: CHAT_NODE_WIDTH, height: 268 };
    case "clarification_answer":
      return { width: CHAT_NODE_WIDTH, height: 140 };
    case "requirement_spec":
      return { width: CHAT_NODE_WIDTH, height: 300 };
    case "requirement_confirmation":
      return { width: CHAT_NODE_WIDTH, height: 284 };
  }
}

export function displayItemSize(
  item: BranchDisplayItem,
  sizes: BranchDisplayItemSizes,
): NodeSize {
  const measured = sizes[displayItemId(item)];
  if (measured?.width && measured?.height) return measured;
  return estimatedDisplayItemSize(item);
}

/**
 * 用真实节点边界重新投影活动分支：每个后继的顶边始终位于前驱底边 48px 之后。
 * x 车道来自 DAG 的稳定逻辑位置，流式增高只会推动后继的 y。
 */
export function layoutBranchDisplay(
  items: BranchDisplayItem[],
  sizes: BranchDisplayItemSizes,
): BranchDisplayItem[] {
  let nextY = 0;
  return items.map((item) => {
    const positioned = {
      ...item,
      position: { x: item.position.x, y: nextY },
    } as BranchDisplayItem;
    nextY += displayItemSize(item, sizes).height + CHAT_NODE_GAP;
    return positioned;
  });
}

/**
 * React Flow 在节点首次测量前会强制挂载全部节点；因此大历史不能只依赖
 * onlyRenderVisibleElements。这里先按估算/实测边界裁出当前窗口，并额外保留
 * 一屏 overscan、相邻项和显式聚焦项。items 已按 y 单调排列，可用二分定位。
 */
export function visibleBranchItems(
  items: BranchDisplayItem[],
  sizes: BranchDisplayItemSizes,
  viewport: BranchDisplayViewport,
  host: { width: number; height: number },
  pinnedIds: readonly string[] = [],
): BranchDisplayItem[] {
  if (items.length === 0) return [];
  const zoom = Math.max(viewport.zoom, 0.01);
  const overscan = Math.max((host.height / zoom) * 0.5, 320);
  const top = -viewport.y / zoom - overscan;
  const bottom = (host.height - viewport.y) / zoom + overscan;

  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const item = items[middle];
    const itemBottom = item.position.y + displayItemSize(item, sizes).height;
    if (itemBottom < top) low = middle + 1;
    else high = middle;
  }
  const first = Math.max(0, low - 1);

  low = first;
  high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (items[middle].position.y <= bottom) low = middle + 1;
    else high = middle;
  }
  const lastExclusive = Math.min(items.length, low + 1);

  const indexes = new Set<number>();
  for (let index = first; index < lastExclusive; index += 1) {
    indexes.add(index);
  }
  const byId = new Map(
    items.map((item, index) => [displayItemId(item), index] as const),
  );
  for (const id of pinnedIds) {
    const index = byId.get(id);
    if (index === undefined) continue;
    indexes.add(index);
    if (index > 0) indexes.add(index - 1);
    if (index + 1 < items.length) indexes.add(index + 1);
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => items[index]);
}

export const processGroupId = (firstMemberId: string) => `pg:${firstMemberId}`;

const COLLAPSIBLE_KINDS = new Set(["process", "tool"]);

/**
 * 分支展示投影：祖先共享 + 本分支节点按链序排列；
 * 回答已终态时，其前方连续的过程/工具节点默认折叠为可逆 ProcessGroup
 * （FE-CHAT-010/011）；分支无活动节点时末端放置唯一 Composer（FE-CHAT-007）。
 */
export function projectBranchDisplay(
  state: ConversationGraphState,
  branchId: string,
  expandedProcessGroupIds: string[],
  inputGate: BranchInputGate | null = null,
): BranchDisplayItem[] {
  const visible = Object.values(state.nodes)
    .filter((node) => node.branch_ids.includes(branchId))
    .sort((a, b) => {
      const pa = state.positions[a.id];
      const pb = state.positions[b.id];
      if (pa && pb && pa.y !== pb.y) return pa.y - pb.y;
      return a.created_at.localeCompare(b.created_at);
    });

  const expanded = new Set(expandedProcessGroupIds);
  const items: BranchDisplayItem[] = [];
  let index = 0;
  while (index < visible.length) {
    const node = visible[index];
    if (COLLAPSIBLE_KINDS.has(node.kind) && !isActiveState(node.state)) {
      let end = index;
      while (
        end + 1 < visible.length &&
        COLLAPSIBLE_KINDS.has(visible[end + 1].kind) &&
        !isActiveState(visible[end + 1].state)
      ) {
        end += 1;
      }
      const next = visible[end + 1];
      const followedByTerminalAnswer =
        next?.kind === "assistant_answer" && !isActiveState(next.state);
      if (end > index && followedByTerminalAnswer) {
        const members = visible.slice(index, end + 1);
        const id = processGroupId(members[0].id);
        const isExpanded = expanded.has(id);
        const firstPos = state.positions[members[0].id];
        items.push({
          type: "process_group",
          id,
          members,
          position: firstPos,
          expanded: isExpanded,
        });
        if (!isExpanded) {
          index = end + 1;
          continue;
        }
        // 展开：组头之后依次展示原始成员；真实边界布局由 layoutBranchDisplay 计算。
        index = end + 1;
        for (const member of members) {
          const pos = state.positions[member.id];
          items.push({
            type: "node",
            node: member,
            position: pos,
          });
        }
        continue;
      }
    }
    const pos = state.positions[node.id] ?? { x: 0, y: 0 };
    items.push({
      type: "node",
      node,
      position: pos,
    });
    index += 1;
  }

  if (branchActiveNodes(state, branchId).length === 0 && !inputGate) {
    const last = items[items.length - 1];
    const lane =
      last &&
      !(
        last.type === "node" &&
        isExclusiveToBranch(state, last.node.id, branchId)
      )
        ? (state.branchLanes[branchId] ?? 0)
        : 0;
    items.push({
      type: "composer",
      id: `composer:${branchId}`,
      branchId,
      position: last
        ? {
            x: last.position.x + lane * CHAT_BRANCH_OFFSET_X,
            y: last.position.y + CHAT_NODE_ORDER_STEP,
          }
        : { x: 0, y: 0 },
    });
  }
  return items;
}

/** 分支末端展示位置（自动跟随定位用） */
export function branchEndPosition(items: BranchDisplayItem[]): Point | null {
  const last = items[items.length - 1];
  return last ? last.position : null;
}

/** 自动跟随目标：活动节点 → 当前业务输入节点 → 新持久节点 → Composer。 */
export function followTargetItem(
  items: BranchDisplayItem[],
  inputGate: BranchInputGate | null = null,
  preferredNodeId: string | null = null,
): BranchDisplayItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "node" && isActiveState(item.node.state)) return item;
  }
  if (inputGate?.targetNodeId) {
    const target = items.find(
      (item) => displayItemId(item) === inputGate.targetNodeId,
    );
    if (target) return target;
  }
  if (preferredNodeId) {
    const target = items.find(
      (item) => displayItemId(item) === preferredNodeId,
    );
    if (target) return target;
  }
  return items.at(-1) ?? null;
}

export function followTargetPosition(items: BranchDisplayItem[]): Point | null {
  return followTargetItem(items)?.position ?? null;
}
