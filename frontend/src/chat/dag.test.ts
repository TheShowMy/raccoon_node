import { describe, expect, it } from "vitest";
import type {
  ClarificationRound,
  ConversationBranch,
  ConversationNode,
  Requirement,
} from "../api/types";
import {
  CHAT_BRANCH_OFFSET_X,
  CHAT_NODE_GAP,
  branchActiveNodes,
  createGraphState,
  deriveBranchInputGate,
  displayItemId,
  followTargetItem,
  layoutBranchDisplay,
  processGroupId,
  projectBranchDisplay,
  reduceBranchCreated,
  reduceNodeCreated,
  reduceNodeDelta,
  reduceNodeRedacted,
  reduceNodeStateChanged,
  visibleBranchItems,
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
    clarification_round_id: null,
    redacted_at: null,
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
  it("节点沿链记录稳定逻辑顺序，分支末端推进", () => {
    const { state, ids } = buildScriptedGraph();
    expect(state.positions[ids.user]).toEqual({ x: 0, y: 0 });
    expect(state.positions[ids.process].y).toBe(1);
    expect(state.positions[ids.answer].y).toBe(3);
    expect(state.heads["b-main"]).toBe(ids.answer);
  });

  it("不同高度节点始终保持 48px 外框间距", () => {
    const { state } = buildScriptedGraph();
    const projected = projectBranchDisplay(state, "b-main", []);
    const heights = [96, 248, 184, 312];
    const sizes = Object.fromEntries(
      projected.map((item, index) => [
        displayItemId(item),
        { width: 320, height: heights[index] ?? 160 },
      ]),
    );
    const laidOut = layoutBranchDisplay(projected, sizes);
    for (let index = 1; index < laidOut.length; index += 1) {
      const previous = laidOut[index - 1];
      const current = laidOut[index];
      expect(
        current.position.y -
          (previous.position.y + sizes[displayItemId(previous)].height),
      ).toBe(CHAT_NODE_GAP);
    }
  });

  it("流式节点增高只推动后继，已完成前驱保持稳定", () => {
    const { state } = buildScriptedGraph();
    const projected = projectBranchDisplay(state, "b-main", []);
    const ids = projected.map(displayItemId);
    const before = layoutBranchDisplay(
      projected,
      Object.fromEntries(ids.map((id) => [id, { width: 320, height: 120 }])),
    );
    const growingId = ids[1];
    const after = layoutBranchDisplay(projected, {
      ...Object.fromEntries(ids.map((id) => [id, { width: 320, height: 120 }])),
      [growingId]: { width: 320, height: 280 },
    });
    expect(after[0].position).toEqual(before[0].position);
    expect(after[1].position).toEqual(before[1].position);
    expect(after[2].position.y - before[2].position.y).toBe(160);
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

describe("对话 DAG：redact 保留图结构", () => {
  it("清空正文、阻止后续 delta，并保留 ID、父边和分支", () => {
    let state = createGraphState("g-main", "b-main");
    const node = makeNode({
      kind: "assistant_answer",
      branch_ids: ["b-main"],
      state: "streaming",
      content: "敏感正文",
      parent_ids: ["n-parent"],
    });
    state = reduceNodeCreated(state, node);
    state = reduceNodeRedacted(state, {
      node_id: node.id,
      redacted_at: "2026-07-17T00:00:00Z",
    });
    state = reduceNodeDelta(state, {
      node_id: node.id,
      node_sequence: 1,
      delta: "不应恢复",
    });
    expect(state.nodes[node.id]).toMatchObject({
      id: node.id,
      content: "",
      parent_ids: ["n-parent"],
      branch_ids: ["b-main"],
      redacted_at: "2026-07-17T00:00:00Z",
    });
  });
});

describe("对话 DAG：大规模投影", () => {
  it("一万个节点可投影并保持末端 Composer", () => {
    const nodes: ConversationGraphState["nodes"] = {};
    const positions: ConversationGraphState["positions"] = {};
    for (let index = 0; index < 10_000; index += 1) {
      const id = `large-${index}`;
      nodes[id] = makeNode({
        id,
        kind: index % 2 === 0 ? "user_message" : "assistant_answer",
        branch_ids: ["b-main"],
        parent_ids: index === 0 ? [] : [`large-${index - 1}`],
        created_at: new Date(1_700_000_000_000 + index).toISOString(),
      });
      positions[id] = { x: 0, y: index };
    }
    const state: ConversationGraphState = {
      ...createGraphState("g-main", "b-main"),
      nodes,
      positions,
      heads: { "b-main": "large-9999" },
    };
    const items = layoutBranchDisplay(
      projectBranchDisplay(state, "b-main", []),
      {},
    );
    expect(items).toHaveLength(10_001);
    expect(items.at(-1)?.type).toBe("composer");
    expect(items[1].position.y).toBeGreaterThan(items[0].position.y);

    const visible = visibleBranchItems(
      items,
      {},
      { x: 32, y: 32, zoom: 1 },
      { width: 1_000, height: 700 },
      ["large-9999"],
    );
    expect(visible.length).toBeLessThan(30);
    expect(visible.map(displayItemId)).toContain("large-9999");
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
      y: 1,
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
    // 展开后成员在组头之后，事实坐标保持不变，真实边界由展示布局计算。
    const memberProcess = expanded[2];
    const memberTool = expanded[3];
    expect(memberProcess.type === "node" && memberProcess.node.id).toBe(
      ids.process,
    );
    expect(memberTool.type === "node" && memberTool.node.id).toBe(ids.tool);
    expect(memberProcess.position.y).toBe(state.positions[ids.process].y);
    const answer = expanded[4];
    expect(answer.position.y).toBe(state.positions[ids.answer].y);
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

  it("自动跟随选择最后一个活动节点，空闲时选择 Composer", () => {
    let state = createGraphState("g-main", "b-main");
    const user = makeNode({ kind: "user_message", branch_ids: ["b-main"] });
    state = reduceNodeCreated(state, user);
    const process = makeNode({
      kind: "process",
      branch_ids: ["b-main"],
      parent_ids: [user.id],
      state: "running",
    });
    state = reduceNodeCreated(state, process);
    const tool = makeNode({
      kind: "tool",
      branch_ids: ["b-main"],
      parent_ids: [process.id],
      state: "running",
    });
    state = reduceNodeCreated(state, tool);
    let items = projectBranchDisplay(state, "b-main", []);
    const activeTarget = followTargetItem(items);
    expect(activeTarget?.type).toBe("node");
    expect(activeTarget?.type === "node" ? activeTarget.node.id : null).toBe(
      tool.id,
    );
    state = reduceNodeStateChanged(state, {
      node_id: process.id,
      state: "completed",
    });
    state = reduceNodeStateChanged(state, {
      node_id: tool.id,
      state: "completed",
    });
    items = projectBranchDisplay(state, "b-main", []);
    expect(followTargetItem(items)?.type).toBe("composer");
  });

  it("澄清到确认期间由业务节点独占输入，确认后恢复 Composer", () => {
    let state = createGraphState("g-main", "b-main");
    const question = makeNode({
      kind: "clarification_question",
      branch_ids: ["b-main"],
      requirement_id: "req-1",
      clarification_round_id: "round-1",
    });
    state = reduceNodeCreated(state, question);
    const requirement: Requirement = {
      id: "req-1",
      title: "节点跟随",
      state: "clarifying",
      source_session_id: "s-main",
      source_branch_id: "b-main",
      source_node_ids: [],
      latest_revision: 0,
      confirmed_revision: null,
      queue_position: null,
      latest_run_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const round: ClarificationRound = {
      id: "round-1",
      requirement_id: requirement.id,
      question: "选择范围",
      mode: "single_choice",
      options: [],
      allow_custom: true,
      answer: null,
      state: "pending",
      asked_at: "2026-01-01T00:00:01.000Z",
      answered_at: null,
    };
    let gate = deriveBranchInputGate(state, "b-main", [requirement], [round]);
    let items = projectBranchDisplay(state, "b-main", [], gate);
    expect(items.some((item) => item.type === "composer")).toBe(false);
    expect(displayItemId(followTargetItem(items, gate)!)).toBe(question.id);

    const spec = makeNode({
      kind: "requirement_spec",
      branch_ids: ["b-main"],
      parent_ids: [question.id],
      requirement_id: requirement.id,
      requirement_revision: 1,
    });
    state = reduceNodeCreated(state, spec);
    const confirmation = makeNode({
      kind: "requirement_confirmation",
      branch_ids: ["b-main"],
      parent_ids: [spec.id],
      requirement_id: requirement.id,
      requirement_revision: 1,
    });
    state = reduceNodeCreated(state, confirmation);
    const specReady = {
      ...requirement,
      state: "spec_ready" as const,
      latest_revision: 1,
    };
    gate = deriveBranchInputGate(state, "b-main", [specReady], [round]);
    items = projectBranchDisplay(state, "b-main", [], gate);
    expect(items.some((item) => item.type === "composer")).toBe(false);
    expect(displayItemId(followTargetItem(items, gate)!)).toBe(confirmation.id);

    const queued = {
      ...specReady,
      state: "queued" as const,
      confirmed_revision: 1,
    };
    gate = deriveBranchInputGate(state, "b-main", [queued], [round]);
    items = projectBranchDisplay(state, "b-main", [], gate);
    expect(gate).toBeNull();
    expect(items.at(-1)?.type).toBe("composer");
  });

  it("无活动业务节点时优先定位本次新建的持久节点", () => {
    let state = createGraphState("g-main", "b-main");
    const user = makeNode({
      kind: "user_message",
      branch_ids: ["b-main"],
    });
    state = reduceNodeCreated(state, user);
    const items = projectBranchDisplay(state, "b-main", []);
    expect(displayItemId(followTargetItem(items, null, user.id)!)).toBe(
      user.id,
    );
  });
});
