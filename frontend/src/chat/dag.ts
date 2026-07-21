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

export type ConversationGraphState = {
  graph_id: string;
  root_branch_id: string;
  nodes: Record<string, ConversationNode>;
  branches: Record<string, ConversationBranch>;
  /** branch_id → 分支末端节点 id（空串表示分支尚无节点） */
  heads: Record<string, string>;
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
    heads: { [root_branch_id]: "" },
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

export function reduceNodeCreated(
  state: ConversationGraphState,
  node: ConversationNode,
): ConversationGraphState {
  if (state.nodes[node.id]) return state;
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
  return {
    ...state,
    nodes,
    branches: { ...state.branches, [branch.id]: branch },
    heads: {
      ...state.heads,
      [branch.id]: state.heads[branch.id] ?? branch.anchor_node_id ?? "",
    },
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
    chain.push(current);
    const parentId = current.parent_ids[current.parent_ids.length - 1];
    current = parentId ? state.nodes[parentId] : undefined!;
  }
  return chain.reverse();
}

/* ── 展示投影 ── */

export type BranchDisplayItem =
  | { type: "node"; node: ConversationNode }
  | {
      type: "process_group";
      id: string;
      members: ConversationNode[];
      /** 展开时组头保留，成员紧随其后，可逆折叠（FE-CHAT-010） */
      expanded: boolean;
    }
  | { type: "composer"; id: string; branchId: string };

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
export function estimatedDisplayItemHeight(item: BranchDisplayItem): number {
  if (item.type === "composer") return 292;
  if (item.type === "process_group") return 132;
  switch (item.node.kind) {
    case "user_message":
      return 156;
    case "process":
      return 148;
    case "tool":
      return 176;
    case "assistant_answer":
      return 196;
    case "clarification_question":
      return 268;
    case "clarification_answer":
      return 140;
    case "requirement_spec":
      return 300;
    case "requirement_confirmation":
      return 284;
  }
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
  const head = state.heads[branchId];
  const visible = head ? ancestorChain(state, head) : [];

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
        items.push({
          type: "process_group",
          id,
          members,
          expanded: isExpanded,
        });
        if (!isExpanded) {
          index = end + 1;
          continue;
        }
        // 展开：组头之后依次展示原始成员。
        index = end + 1;
        for (const member of members) {
          items.push({
            type: "node",
            node: member,
          });
        }
        continue;
      }
    }
    items.push({
      type: "node",
      node,
    });
    index += 1;
  }

  if (branchActiveNodes(state, branchId).length === 0 && !inputGate) {
    items.push({
      type: "composer",
      id: `composer:${branchId}`,
      branchId,
    });
  }
  return items;
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
