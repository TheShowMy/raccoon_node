import { describe, expect, it } from "vitest";
import {
  buildBubbleStreamFromEvents,
  buildStreamingTextFromEvents,
  formatCompactNumber,
  formatDate,
  githubUrlFromGitUrl,
  shortenGitUrl,
} from "../utils/format";
import type { ProjectChatEvent, StreamEvent } from "../types/api";

describe("format utilities", () => {
  it("strips protocol from Git URLs", () => {
    expect(shortenGitUrl("https://github.com/example/repo.git")).toBe(
      "github.com/example/repo.git",
    );
    expect(shortenGitUrl("git@github.com:example/repo.git")).toBe(
      "github.com/example/repo.git",
    );
  });

  it("formats ISO dates", () => {
    const date = new Date("2026-06-18T10:30:00Z").toISOString();
    expect(formatDate(date)).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
  });

  it("formats large numbers with Chinese units", () => {
    expect(formatCompactNumber(0)).toBe("0");
    expect(formatCompactNumber(9999)).toBe("9,999");
    expect(formatCompactNumber(10_000)).toBe("1.0万");
    expect(formatCompactNumber(2_814_061)).toBe("281.4万");
    expect(formatCompactNumber(34_009_232)).toBe("3400.9万");
    expect(formatCompactNumber(100_000_000)).toBe("1.0亿");
    expect(formatCompactNumber(150_000_000)).toBe("1.5亿");
  });

  it("builds GitHub web URLs from clone URLs", () => {
    expect(githubUrlFromGitUrl("https://github.com/example/repo.git")).toBe(
      "https://github.com/example/repo",
    );
    expect(githubUrlFromGitUrl("git@github.com:example/repo.git")).toBe(
      "https://github.com/example/repo",
    );
    expect(githubUrlFromGitUrl("https://example.com/repo.git")).toBeNull();
  });

  it("builds live bubbles from Pi thinking and tool events", () => {
    const events: StreamEvent[] = [
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "先看入口。",
          },
        },
      },
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "再看路由。",
          },
        },
      },
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "工具开始执行。",
        pi_type: "tool_execution_start",
        payload: { toolCallId: "tool-1", toolName: "rg" },
      },
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "工具执行完成。",
        pi_type: "tool_execution_end",
        payload: {
          toolCallId: "tool-1",
          result: { content: [{ text: "src/main.rs" }] },
        },
      },
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "完成。",
        pi_type: "agent_end",
        payload: {},
      },
    ];

    expect(buildBubbleStreamFromEvents(events)).toMatchObject([
      {
        type: "thinking",
        content: "先看入口。再看路由。",
        status: "done",
      },
      {
        type: "tool",
        label: "rg",
        content: "src/main.rs",
        status: "done",
      },
      {
        type: "status",
        label: "处理完成",
        status: "done",
      },
    ]);
  });

  it("keeps old tool output when updates are deltas", () => {
    const events: StreamEvent[] = [
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "工具开始执行。",
        pi_type: "tool_execution_start",
        payload: { toolCallId: "tool-1", toolName: "Read" },
      },
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "工具更新。",
        pi_type: "tool_execution_update",
        payload: {
          toolCallId: "tool-1",
          partialResult: { content: [{ text: "第一段" }] },
        },
      },
      ...Array.from({ length: 120 }, (_, index) => ({
        requirement_id: "req-1",
        event: "pi_event",
        message: "工具更新。",
        pi_type: "tool_execution_update" as const,
        payload: {
          toolCallId: "tool-1",
          partialResult: { content: [{ text: `第${index + 2}段` }] },
        },
      })),
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "工具执行完成。",
        pi_type: "tool_execution_end",
        payload: {
          toolCallId: "tool-1",
          result: { content: [{ text: "最后一段" }] },
        },
      },
    ];

    const tool = buildBubbleStreamFromEvents(events).find(
      (bubble) => bubble.type === "tool",
    );
    expect(tool?.content).toContain("第一段");
    expect(tool?.content).toContain("第121段");
    expect(tool?.content).toContain("最后一段");
    expect(tool?.status).toBe("done");
  });

  it("creates a tool bubble when update arrives without start", () => {
    const events: StreamEvent[] = [
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "工具更新。",
        pi_type: "tool_execution_update",
        payload: {
          toolCallId: "tool-late",
          toolName: "Bash",
          partialResult: { content: [{ text: "输出" }] },
        },
      },
    ];

    expect(buildBubbleStreamFromEvents(events)).toMatchObject([
      {
        id: "tool-late",
        type: "tool",
        label: "Bash",
        content: "输出",
        status: "running",
      },
    ]);
  });

  it("extracts streaming answer text from text_delta events", () => {
    const events: ProjectChatEvent[] = [
      {
        project_id: "project-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: { type: "text_delta", delta: "入口在" },
        },
      },
      {
        project_id: "project-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: { type: "text_delta", delta: " src/main.rs" },
        },
      },
    ];

    expect(buildStreamingTextFromEvents(events)).toBe("入口在 src/main.rs");
  });

  it("ignores thinking_delta when extracting streaming text", () => {
    const events: ProjectChatEvent[] = [
      {
        project_id: "project-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: { type: "thinking_delta", delta: "思考中" },
        },
      },
      {
        project_id: "project-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: { type: "text_delta", delta: "答案" },
        },
      },
    ];

    expect(buildStreamingTextFromEvents(events)).toBe("答案");
  });

  it("falls back to text field when delta is absent", () => {
    const events: ProjectChatEvent[] = [
      {
        project_id: "project-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: { type: "content_delta", text: "第一段" },
        },
      },
      {
        project_id: "project-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: { type: "message_delta", text: "第二段" },
        },
      },
    ];

    expect(buildStreamingTextFromEvents(events)).toBe("第一段第二段");
  });

  it("returns empty string when no text deltas exist", () => {
    const events: ProjectChatEvent[] = [
      {
        project_id: "project-1",
        event: "pi_event",
        message: "工具开始执行。",
        pi_type: "tool_execution_start",
        payload: { toolCallId: "tool-1", toolName: "rg" },
      },
    ];

    expect(buildStreamingTextFromEvents(events)).toBe("");
  });
});
