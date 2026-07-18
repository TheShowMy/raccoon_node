import { describe, expect, it } from "vitest";
import type { ConversationNode, WorkbenchAction } from "../api/types";
import {
  anchoredConversationViewport,
  anchoredRenderedNodeViewport,
  followTransitionDuration,
  projectConversationActions,
  shouldMoveConversationCamera,
} from "./ConversationGraph";
import { CHAT_NODE_GAP, type BranchDisplayItem } from "./dag";

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

describe("ConversationGraph 相机", () => {
  it("保持 zoom 并把真实中心锚到 50%/65%", () => {
    const viewport = anchoredConversationViewport(
      item,
      { "n-active": { width: 360, height: 240 } },
      { width: 1_000, height: 800 },
      1.25,
    );
    expect(viewport.zoom).toBe(1.25);
    expect((100 + 180) * viewport.zoom + viewport.x).toBe(500);
    expect((300 + 120) * viewport.zoom + viewport.y).toBe(520);
  });

  it("用当前 DOM 边界补偿晚到的真实节点尺寸", () => {
    const viewport = anchoredRenderedNodeViewport(
      { left: 430, top: 300, width: 320, height: 240 },
      { left: 100, top: 20, width: 1_000, height: 800 },
      { x: 40, y: -30, zoom: 1.25 },
    );
    expect(viewport.zoom).toBe(1.25);
    expect(430 + 160 - 100 + viewport.x - 40).toBe(500);
    expect(300 + 120 - 20 + viewport.y + 30).toBe(520);
  });

  it("新目标与实测补偿使用快速平滑过渡，reduced-motion 直接定位", () => {
    expect(followTransitionDuration(false, false)).toBe(220);
    expect(followTransitionDuration(false, true)).toBe(100);
    expect(followTransitionDuration(true, false)).toBe(0);
  });

  it("小于 1px 的补偿不会重复移动相机", () => {
    const current = { x: 100, y: 200, zoom: 1 };
    expect(
      shouldMoveConversationCamera(current, {
        x: 100.9,
        y: 199.1,
        zoom: 1.0009,
      }),
    ).toBe(false);
    expect(
      shouldMoveConversationCamera(current, { x: 101, y: 200, zoom: 1 }),
    ).toBe(true);
  });
});

describe("ConversationGraph redact 确认链", () => {
  it("来源右侧和确认下方均保持 48px 外框间距", () => {
    const action: WorkbenchAction = {
      id: "a-redact",
      kind: "conversation_redact",
      title: "删除节点内容",
      impact: "清除正文",
      irreversible: true,
      source_node_id: node.id,
      payload: { node_id: node.id },
      confirm_token: "token",
      state: "confirmed",
      result: { ok: true, message: "已删除" },
      created_at: "2026-07-17T00:00:00Z",
      updated_at: "2026-07-17T00:00:00Z",
    };
    const sizes = {
      [node.id]: { width: 320, height: 180 },
      "chat-action-confirm:a-redact": { width: 340, height: 230 },
      "chat-action-result:a-redact": { width: 340, height: 150 },
    };
    const projection = projectConversationActions([action], [item], sizes);
    const confirmation = projection.nodes[0];
    const result = projection.nodes[1];
    expect(confirmation.position.x - (item.position.x + 320)).toBe(
      CHAT_NODE_GAP,
    );
    expect(result.position.y - (confirmation.position.y + 230)).toBe(
      CHAT_NODE_GAP,
    );
  });
});
