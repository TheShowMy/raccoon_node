import { describe, expect, it } from "vitest";
import type { ConversationBranch, ConversationNode } from "../api/types";
import {
  CHAT_BRANCH_OFFSET_X,
  CHAT_NODE_SLOT_Y,
  branchActiveNodes,
  createGraphState,
  processGroupId,
  projectBranchDisplay,
  reduceBranchCreated,
  reduceNodeCreated,
  reduceNodeDelta,
  reduceNodeStateChanged,
  type ConversationGraphState,
} from "./dag";

let counter = 0;
function makeNode(
  partial: Partial<ConversationNode> &
    Pick<ConversationNode, "kind" | "branch_ids">,
): ConversationNode {
  counter += 1;
  return {
    id: `n${counter}`,
    graph_id: "g-main",
    state: "completed",
    content: "",
    node_sequence: 0,
    intent: null,
    parent_ids: [],
    created_at: new Date(1_700_000_000_000 + counter * 1000).toISOString(),
    completed_at: null,
    requirement_id: null,
    requirement_revision: null,
    tool_activity: null,
    ...partial,
  };
}

function makeBranch(
  id: string,
  anchor: string | null,
  parent: string | null,
): ConversationBranch {
  return {
    id,
    graph_id: "g-main",
    anchor_node_id: anchor,
    parent_branch_id: parent,
    created_at: new Date().toISOString(),
  };
}

/** 典型脚本：用户 → 过程 → 工具 → 回答（全部完成） */
function buildScriptedGraph(): {
  state: ConversationGraphState;
  ids: Record<"user" | "process" | "tool" | "answer", string>;
} {
  let state = createGraphState("g-main", "b-main");
  const user = makeNode({
    kind: "user_message",
    branch_ids: ["b-main"],
    content: "做一个功能",
  });
  state = reduceNodeCreated(state, user);
  const process = makeNode({
    kind: "process",
    branch_ids: ["b-main"],
    parent_ids: [user.id],
    state: "streaming",
  });
  state = reduceNodeCreated(state, process);
  state = reduceNodeDelta(state, {
    node_id: process.id,
    node_sequence: 1,
    delta: "理解目标。",
  });
  state = reduceNodeDelta(state, {
    node_id: process.id,
    node_sequence: 2,
    delta: "继续。",
  });
  state = reduceNodeStateChanged(state, {
    node_id: process.id,
    state: "completed",
  });
  const tool = makeNode({
    kind: "tool",
    branch_ids: ["b-main"],
    parent_ids: [process.id],
  });
  state = reduceNodeCreated(state, tool);
  const answer = makeNode({
    kind: "assistant_answer",
    branch_ids: ["b-main"],
    parent_ids: [tool.id],
    content: "已完成",
  });
  state = reduceNodeCreated(state, answer);
  return {
    state,
    ids: {
      user: user.id,
      process: process.id,
      tool: tool.id,
      answer: answer.id,
    },
  };
}

describe("对话 DAG：创建与布局", () => {
  it("节点沿链垂直排布，分支末端推进", () => {
    const { state, ids } = buildScriptedGraph();
    expect(state.positions[ids.user]).toEqual({ x: 0, y: 0 });
    expect(state.positions[ids.process].y).toBe(CHAT_NODE_SLOT_Y);
    expect(state.positions[ids.answer].y).toBe(CHAT_NODE_SLOT_Y * 3);
    expect(state.heads["b-main"]).toBe(ids.answer);
  });
});

describe("对话 DAG：node delta 有序去重（FE-CHAT-008、FE-EVENT-004）", () => {
  it("按 node_sequence 追加，重复与缺口拒绝", () => {
    let state = createGraphState("g-main", "b-main");
    const process = makeNode({
      kind: "process",
      branch_ids: ["b-main"],
      state: "streaming",
    });
    state = reduceNodeCreated(state, process);
    state = reduceNodeDelta(state, {
      node_id: process.id,
      node_sequence: 1,
      delta: "a",
    });
    state = reduceNodeDelta(state, {
      node_id: process.id,
      node_sequence: 2,
      delta: "b",
    });
    // 重复
    state = reduceNodeDelta(state, {
      node_id: process.id,
      node_sequence: 2,
      delta: "X",
    });
    state = reduceNodeDelta(state, {
      node_id: process.id,
      node_sequence: 1,
      delta: "Y",
    });
    // 缺口（期望 3，来 5）
    state = reduceNodeDelta(state, {
      node_id: process.id,
      node_sequence: 5,
      delta: "Z",
    });
    const node = state.nodes[process.id];
    expect(node.content).toBe("ab");
    expect(node.node_sequence).toBe(2);
  });
});

describe("对话 DAG：abort（FE-CHAT-005）", () => {
  it("活动节点转 aborted 后分支回到空闲，Composer 回到末端", () => {
    let state = createGraphState("g-main", "b-main");
    const user = makeNode({ kind: "user_message", branch_ids: ["b-main"] });
    state = reduceNodeCreated(state, user);
    const answer = makeNode({
      kind: "assistant_answer",
      branch_ids: ["b-main"],
      parent_ids: [user.id],
      state: "streaming",
    });
    state = reduceNodeCreated(state, answer);
    state = reduceNodeDelta(state, {
      node_id: answer.id,
      node_sequence: 1,
      delta: "半截回答",
    });
    expect(branchActiveNodes(state, "b-main")).toHaveLength(1);
    // 有活动节点时没有 Composer
    let items = projectBranchDisplay(state, "b-main", []);
    expect(items.at(-1)?.type).toBe("node");
    state = reduceNodeStateChanged(state, {
      node_id: answer.id,
      state: "aborted",
    });
    expect(branchActiveNodes(state, "b-main")).toHaveLength(0);
    items = projectBranchDisplay(state, "b-main", []);
    expect(items.at(-1)?.type).toBe("composer");
    // 已接收内容保留
    const answerItem = items.find(
      (i) => i.type === "node" && i.node.id === answer.id,
    );
    expect(answerItem?.type === "node" && answerItem.node.content).toBe(
      "半截回答",
    );
    expect(answerItem?.type === "node" && answerItem.node.state).toBe(
      "aborted",
    );
  });
});

describe("对话 DAG：branchFrom（FE-CHAT-011、PRD-CHAT-009）", () => {
  it("新分支共享祖先、错层布局，原分支不可改写", () => {
    const { state: base, ids } = buildScriptedGraph();
    const branch = makeBranch("b-1", ids.user, "b-main");
    let state = reduceBranchCreated(base, {
      branch,
      shared_node_ids: [ids.user],
    });
    // 祖先被共享
    expect(state.nodes[ids.user].branch_ids).toContain("b-1");
    expect(state.heads["b-1"]).toBe(ids.user);
    // 原分支投影不变
    const before = projectBranchDisplay(base, "b-main", []);
    const after = projectBranchDisplay(state, "b-main", []);
    expect(after.map((i) => (i.type === "node" ? i.node.id : i.type))).toEqual(
      before.map((i) => (i.type === "node" ? i.node.id : i.type)),
    );
    // 新分支第一个节点错层（lane 1）
    const branched = makeNode({
      kind: "user_message",
      branch_ids: ["b-1"],
      parent_ids: [ids.user],
      content: "换个方向",
    });
    state = reduceNodeCreated(state, branched);
    expect(state.positions[branched.id]).toEqual({
      x: CHAT_BRANCH_OFFSET_X,
      y: CHAT_NODE_SLOT_Y,
    });
    expect(state.heads["b-1"]).toBe(branched.id);
    // 新分支投影：共享祖先 + 新节点 + Composer
    const items = projectBranchDisplay(state, "b-1", []);
    const kinds = items.map((i) => i.type);
    expect(kinds[0]).toBe("node");
    expect(items.at(-1)?.type).toBe("composer");
    expect(
      items
        .filter((i) => i.type === "node")
        .map((i) => (i.type === "node" ? i.node.id : "")),
    ).toEqual([ids.user, branched.id]);
    // 同锚点第二分支错到更外侧车道
    const branch2 = makeBranch("b-2", ids.user, "b-main");
    state = reduceBranchCreated(state, {
      branch: branch2,
      shared_node_ids: [ids.user],
    });
    const second = makeNode({
      kind: "user_message",
      branch_ids: ["b-2"],
      parent_ids: [ids.user],
    });
    state = reduceNodeCreated(state, second);
    expect(state.positions[second.id].x).toBe(CHAT_BRANCH_OFFSET_X * 2);
  });
});

describe("对话 DAG：ProcessGroup 可逆折叠（FE-CHAT-010）", () => {
  it("回答完成后过程+工具默认折叠为组，展开恢复成员且不删事实", () => {
    const { state, ids } = buildScriptedGraph();
    const collapsed = projectBranchDisplay(state, "b-main", []);
    const types = collapsed.map((i) => i.type);
    expect(types).toEqual(["node", "process_group", "node", "composer"]);
    const group = collapsed[1];
    expect(group.type).toBe("process_group");
    if (group.type !== "process_group") return;
    expect(group.members.map((m) => m.id)).toEqual([ids.process, ids.tool]);
    expect(group.id).toBe(processGroupId(ids.process));
    // 原节点事实仍在
    expect(state.nodes[ids.process]).toBeDefined();
    expect(state.nodes[ids.tool]).toBeDefined();

    const expanded = projectBranchDisplay(state, "b-main", [group.id]);
    const expandedTypes = expanded.map((i) => i.type);
    expect(expandedTypes).toEqual([
      "node",
      "process_group",
      "node",
      "node",
      "node",
      "composer",
    ]);
    // 展开后成员在组头之后，位置整体下移一个槽位（不推移事实坐标）
    const memberProcess = expanded[2];
    const memberTool = expanded[3];
    expect(memberProcess.type === "node" && memberProcess.node.id).toBe(
      ids.process,
    );
    expect(memberTool.type === "node" && memberTool.node.id).toBe(ids.tool);
    expect(memberProcess.position.y).toBe(
      state.positions[ids.process].y + CHAT_NODE_SLOT_Y,
    );
    const answer = expanded[4];
    expect(answer.position.y).toBe(
      state.positions[ids.answer].y + CHAT_NODE_SLOT_Y,
    );
  });

  it("回答未完成时不折叠（流式期间保持展开）", () => {
    let state = createGraphState("g-main", "b-main");
    const user = makeNode({ kind: "user_message", branch_ids: ["b-main"] });
    state = reduceNodeCreated(state, user);
    const p1 = makeNode({
      kind: "process",
      branch_ids: ["b-main"],
      parent_ids: [user.id],
    });
    state = reduceNodeCreated(state, p1);
    const t1 = makeNode({
      kind: "tool",
      branch_ids: ["b-main"],
      parent_ids: [p1.id],
    });
    state = reduceNodeCreated(state, t1);
    const answer = makeNode({
      kind: "assistant_answer",
      branch_ids: ["b-main"],
      parent_ids: [t1.id],
      state: "streaming",
    });
    state = reduceNodeCreated(state, answer);
    const items = projectBranchDisplay(state, "b-main", []);
    expect(items.some((i) => i.type === "process_group")).toBe(false);
    // 流式中无 Composer
    expect(items.at(-1)?.type).toBe("node");
  });
});
