import { describe, expect, it } from "vitest";
import {
  buildLiveActivity,
  conversationEventsToStreamEvents,
  projectMessageEntries,
} from "./model";

describe("Astryx chat model", () => {
  it("maps project system messages without merging requirement state", () => {
    const entries = projectMessageEntries([
      {
        role: "system",
        content: "需求已确认",
        created_at: "2026-07-10T00:00:00Z",
      },
    ]);

    expect(entries[0]).toMatchObject({
      role: "system",
      text: "需求已确认",
    });
  });

  it("keeps minimal Pi traces without tools or blocks renderable", () => {
    const entries = projectMessageEntries([
      {
        role: "assistant",
        content: "历史回答",
        created_at: "2026-07-10T00:00:00Z",
        metadata: {
          type: "pi_trace",
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

  it("upserts one tool across start, repeated updates and end", () => {
    const activity = buildLiveActivity([
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_start",
        payload: { toolCallId: "tool-1", toolName: "read" },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_update",
        payload: {
          toolCallId: "tool-1",
          toolName: "read",
          partialResult: { content: [{ text: "第一段" }] },
        },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_update",
        payload: {
          toolCallId: "tool-1",
          toolName: "read",
          partialResult: { content: [{ text: "第一段" }] },
        },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_end",
        payload: {
          toolCallId: "tool-1",
          toolName: "read",
          result: { content: [{ text: "第一段第二段" }] },
        },
      },
    ]);

    expect(activity.tools).toEqual([
      expect.objectContaining({
        id: "tool-1",
        name: "read",
        output: "第一段第二段",
        status: "complete",
      }),
    ]);
  });

  it("matches anonymous lifecycle events without creating update rows", () => {
    const activity = buildLiveActivity([
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_update",
        payload: { toolName: "orphan-update" },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_start",
        payload: { toolName: "read", path: "README.md" },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_update",
        payload: { toolName: "read", partialResult: { text: "读取中" } },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_end",
        payload: { toolName: "read", result: { text: "读取完成" } },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_end",
        payload: { toolName: "orphan-end", result: { text: "完成" } },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_end",
        payload: { toolName: "orphan-end", result: { text: "完成" } },
      },
    ]);

    expect(activity.tools).toHaveLength(2);
    expect(activity.tools.map((tool) => tool.name)).toEqual([
      "read",
      "orphan-end",
    ]);
    expect(activity.tools[0]).toMatchObject({
      output: "读取中读取完成",
      status: "complete",
    });
  });

  it("keeps four tool calls at four rows throughout their lifecycle", () => {
    const events = ["read", "search", "edit", "test"].flatMap((name, index) => [
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_start",
        payload: { toolCallId: `tool-${index}`, toolName: name },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_update",
        payload: { toolCallId: `tool-${index}`, toolName: name },
      },
      {
        requirement_id: "requirement-1",
        event: "agent.event",
        message: "",
        pi_type: "tool_execution_end",
        payload: { toolCallId: `tool-${index}`, toolName: name },
      },
    ]);

    expect(buildLiveActivity(events).tools).toHaveLength(4);
  });
});
