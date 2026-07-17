import type {
  ConversationBranch,
  ConversationNode,
  ConversationNodeState,
} from "../api/types";

/**
 * 中央对话 DAG 的客户端投影（纯函数，便于测试）。
 * 事件 reducer 只追加/更新事实：node.delta 按 node_id + node_sequence 有序去重，
 * branchFrom 共享祖先且原分支不可改写，ProcessGroup 是可逆展示投影（不删原节点）。
 */

export type Point = { x: number; y: number };

/** 节点槽位几何：固定槽位保证错层布局稳定 */
export const CHAT_NODE_WIDTH = 320;
export const CHAT_NODE_SLOT_Y = 168;
export const CHAT_BRANCH_OFFSET_X = 380;

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
    y: parentPos.y + CHAT_NODE_SLOT_Y,
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
  // 展开的过程组会多占一个组头槽位：其后的展示位置整体下移（纯投影偏移，不改事实坐标）
  let offsetY = 0;
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
          position: { x: firstPos.x, y: firstPos.y + offsetY },
          expanded: isExpanded,
        });
        if (!isExpanded) {
          index = end + 1;
          continue;
        }
        // 展开：组头占一个槽位，成员节点紧随其后
        offsetY += CHAT_NODE_SLOT_Y;
        index = end + 1;
        for (const member of members) {
          const pos = state.positions[member.id];
          items.push({
            type: "node",
            node: member,
            position: { x: pos.x, y: pos.y + offsetY },
          });
        }
        continue;
      }
    }
    const pos = state.positions[node.id] ?? { x: 0, y: 0 };
    items.push({
      type: "node",
      node,
      position: { x: pos.x, y: pos.y + offsetY },
    });
    index += 1;
  }

  if (branchActiveNodes(state, branchId).length === 0) {
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
            y: last.position.y + CHAT_NODE_SLOT_Y,
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

/** 自动跟随目标：对话进行中聚焦活动（streaming/running）节点，否则聚焦分支末端 */
export function followTargetPosition(items: BranchDisplayItem[]): Point | null {
  const active = items.find(
    (item) => item.type === "node" && isActiveState(item.node.state),
  );
  if (active) return active.position;
  return branchEndPosition(items);
}
