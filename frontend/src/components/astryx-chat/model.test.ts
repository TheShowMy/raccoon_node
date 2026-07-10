import { describe, expect, it } from "vitest";
import {
  buildLiveActivity,
  conversationEventsToStreamEvents,
  projectMessageEntries,
  requirementItemEntries,
} from "./model";

describe("Astryx chat model", () => {
  it("maps project messages without changing structured requirement context", () => {
    const entries = projectMessageEntries([
      {
        role: "system",
        content: "需求已确认",
        created_at: "2026-07-10T00:00:00Z",
        requirement_context: {
          requirement_id: "requirement-1",
          draft: {
            title: "登录改造",
            summary: "改造登录流程",
            acceptance_criteria: ["测试通过"],
          },
          sync_status: "failed",
          sync_error: "主会话忙碌",
        },
      },
    ]);

    expect(entries[0]).toMatchObject({
      role: "system",
      requirementContext: {
        requirement_id: "requirement-1",
        sync_status: "failed",
      },
    });
  });

  it("keeps legacy Pi traces without tools or blocks renderable", () => {
    const entries = projectMessageEntries([
      {
        role: "assistant",
        content: "历史回答",
        created_at: "2026-07-10T00:00:00Z",
        metadata: {
          type: "pi_trace",
          version: 1,
          trace: { thinking: "历史思考" },
        } as never,
      },
    ]);

    expect(entries[0].traceBlocks).toEqual([
      {
        id: "thinking",
        type: "thinking",
        content: "历史思考",
        status: "done",
      },
    ]);
  });

  it("keeps requirement branch items independent from project messages", () => {
    const entries = requirementItemEntries([
      {
        kind: "user",
        id: "user-1",
        text: "增加登录",
        references: [{ path: "src/auth.ts" }],
        created_at: "2026-07-10T00:00:00Z",
      },
      {
        kind: "notice",
        id: "notice-1",
        level: "info",
        text: "正在生成草案",
        created_at: "2026-07-10T00:00:01Z",
      },
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      role: "user",
      references: [{ path: "src/auth.ts" }],
    });
    expect(entries[1]).toMatchObject({ role: "system", noticeLevel: "info" });
  });

  it("normalizes live thinking, tools and output for Astryx components", () => {
    const activity = buildLiveActivity([
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "thinking_delta",
        payload: { delta: "分析需求" },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_start",
        payload: { toolCallId: "tool-1", toolName: "read", path: "README.md" },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "assistant_text_delta",
        payload: { delta: "完成" },
      },
    ]);

    expect(activity.thinking).toBe("分析需求");
    expect(activity.output).toBe("完成");
    expect(activity.tools).toEqual([
      expect.objectContaining({
        id: "tool-1",
        name: "read",
        target: "README.md",
      }),
    ]);
  });

  it("reads nested Pi RPC events from the project chat websocket", () => {
    const events = conversationEventsToStreamEvents([
      {
        type: "agent.event",
        payload: {
          project_id: "current",
          pi_type: "message_update",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              delta: "先检查结构",
            },
          },
        },
      },
      {
        type: "agent.event",
        payload: {
          project_id: "current",
          pi_type: "message_update",
          event: {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "结果" },
          },
        },
      },
      {
        type: "agent.event",
        payload: {
          project_id: "current",
          pi_type: "tool_execution_end",
          event: {
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "read",
            path: "README.md",
          },
        },
      },
    ]);

    expect(buildLiveActivity(events)).toMatchObject({
      thinking: "先检查结构",
      output: "结果",
      tools: [
        {
          id: "tool-1",
          name: "read",
          target: "README.md",
          status: "complete",
        },
      ],
    });
  });
});
