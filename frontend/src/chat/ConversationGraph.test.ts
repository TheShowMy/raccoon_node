import { describe, expect, it } from "vitest";
import type { ConversationNode, WorkbenchAction } from "../api/types";
import { buildRows } from "./ConversationGraph";
import type { BranchDisplayItem } from "./dag";

const node: ConversationNode = {
  id: "n-active",
  graph_id: "g-main",
  kind: "assistant_answer",
  state: "streaming",
  content: "生成中",
  node_sequence: 1,
  intent: null,
  parent_ids: [],
  branch_ids: ["b-main"],
  created_at: "2026-07-17T00:00:00Z",
  completed_at: null,
  requirement_id: null,
  requirement_revision: null,
  clarification_round_id: null,
  redacted_at: null,
  tool_activity: null,
};

const item: BranchDisplayItem = {
  type: "node",
  node,
  position: { x: 100, y: 300 },
};

function redactAction(state: WorkbenchAction["state"]): WorkbenchAction {
  return {
    id: "a-redact",
    kind: "conversation_redact",
    title: "删除节点内容",
    impact: "清除正文",
    irreversible: true,
    source_node_id: node.id,
    payload: { node_id: node.id },
    confirm_token: "token",
    state,
    result: state === "confirmed" ? { ok: true, message: "已删除" } : null,
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
  };
}

describe("对话列表行投影", () => {
  it("确认行紧跟来源条目，等待确认时不投影结果行", () => {
    const rows = buildRows([item], [redactAction("awaiting")]);
    expect(rows.map((row) => row.kind)).toEqual([
      "item",
      "action_confirmation",
    ]);
    expect(rows[1].id).toBe("chat-action-confirm:a-redact");
  });

  it("已确认操作同时投影确认行与结果行", () => {
    const rows = buildRows([item], [redactAction("confirmed")]);
    expect(rows.map((row) => row.kind)).toEqual([
      "item",
      "action_confirmation",
      "action_result",
    ]);
    expect(rows[2].id).toBe("chat-action-result:a-redact");
  });

  it("来源条目不存在或非对话操作的 action 不投影", () => {
    const orphan = { ...redactAction("awaiting"), source_node_id: "n-gone" };
    const other = {
      ...redactAction("awaiting"),
      kind: "git_commit",
    } as unknown as WorkbenchAction;
    expect(buildRows([item], [orphan, other])).toHaveLength(1);
  });
});
