import { describe, expect, it } from "vitest";
import {
  buildBubbleStreamFromEvents,
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

  it("accepts project chat events without rendering raw payloads", () => {
    const events: ProjectChatEvent[] = [
      {
        project_id: "project-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "检查项目结构。",
          },
        },
      },
      {
        project_id: "project-1",
        event: "pi_event",
        message: "本轮完成。",
        pi_type: "turn_end",
        payload: {},
      },
    ];

    expect(buildBubbleStreamFromEvents(events)).toMatchObject([
      {
        type: "thinking",
        content: "检查项目结构。",
        status: "done",
      },
      {
        type: "status",
        label: "本轮处理完成",
      },
    ]);
  });
});
