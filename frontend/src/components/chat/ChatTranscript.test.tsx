// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatTranscriptItem } from "./types";
import ChatTranscript, { isContinuedMessage } from "./ChatTranscript";

const now = "2026-06-22T06:00:00.000Z";
const fiveMinutesLater = "2026-06-22T06:05:00.000Z";
const sixMinutesLater = "2026-06-22T06:06:00.000Z";

describe("ChatTranscript", () => {
  it("renders user and assistant messages", () => {
    const items: ChatTranscriptItem[] = [
      {
        kind: "message",
        id: "m1",
        role: "user",
        content: "我要登录",
        created_at: now,
      },
      {
        kind: "message",
        id: "m2",
        role: "assistant",
        content: "我来澄清范围",
        created_at: now,
        assistantLabel: "Coordinator",
      },
    ];

    render(
      <ChatTranscript items={items} projectId="project-1" running={false} />,
    );

    expect(screen.getByText("我要登录")).toBeInTheDocument();
    expect(screen.getByText("我来澄清范围")).toBeInTheDocument();
    expect(screen.getAllByText("Coordinator").length).toBeGreaterThan(0);
  });

  it("groups continued messages within 5 minutes", () => {
    const items: ChatTranscriptItem[] = [
      {
        kind: "message",
        id: "m1",
        role: "assistant",
        content: "第一行",
        created_at: now,
        assistantLabel: "Coordinator",
      },
      {
        kind: "message",
        id: "m2",
        role: "assistant",
        content: "第二行",
        created_at: fiveMinutesLater,
        assistantLabel: "Coordinator",
      },
      {
        kind: "message",
        id: "m3",
        role: "assistant",
        content: "超过 5 分钟",
        created_at: sixMinutesLater,
        assistantLabel: "Coordinator",
      },
    ];

    const { container } = render(
      <ChatTranscript items={items} running={false} />,
    );
    const timestamps = container.querySelectorAll("time");
    expect(timestamps.length).toBe(1);
  });

  it("renders process rows as a tool-call section", () => {
    const items: ChatTranscriptItem[] = [
      {
        kind: "process",
        id: "p1",
        created_at: now,
        assistantLabel: "Pi Agent",
        rows: [
          {
            id: "t1",
            type: "tool",
            toolCallId: "tool-1",
            toolName: "read",
            output: "src/main.rs",
            preview: "src/main.rs",
            status: "done",
          },
        ],
      },
    ];

    render(<ChatTranscript items={items} running={false} />);

    expect(screen.getByRole("button", { name: /read/ })).toBeInTheDocument();
    expect(screen.getByLabelText("过程")).toBeInTheDocument();
  });

  it("renders info notices and warning notices with actions", () => {
    const onStop = vi.fn();
    const items: ChatTranscriptItem[] = [
      {
        kind: "notice",
        id: "n1",
        level: "info",
        text: "已保存",
        created_at: now,
      },
      {
        kind: "notice",
        id: "n2",
        level: "warning",
        text: "耗时较长",
        created_at: now,
        action: { label: "停止", onClick: onStop, variant: "destructive" },
      },
    ];

    render(<ChatTranscript items={items} running={false} />);

    expect(screen.getByText("已保存")).toBeInTheDocument();
    const stopButton = screen.getByRole("button", { name: "停止" });
    expect(stopButton).toBeInTheDocument();
    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("renders an error banner", () => {
    render(<ChatTranscript items={[]} running={false} error="出错了" />);

    expect(screen.getByText("出错了")).toBeInTheDocument();
  });

  it("shows a thinking indicator when running without process rows", () => {
    render(<ChatTranscript items={[]} running={true} />);

    expect(screen.getByLabelText("正在思考")).toBeInTheDocument();
  });

  it("does not show a thinking indicator when process rows are present", () => {
    const items: ChatTranscriptItem[] = [
      {
        kind: "process",
        id: "p1",
        created_at: now,
        rows: [
          {
            id: "t1",
            type: "tool",
            toolCallId: "tool-1",
            toolName: "read",
            output: "...",
            preview: "src/main.rs",
            status: "running",
          },
        ],
      },
    ];

    render(<ChatTranscript items={items} running={true} />);

    expect(screen.queryByLabelText("正在思考")).not.toBeInTheDocument();
  });
});

describe("isContinuedMessage", () => {
  it("returns true only for same-role messages within 5 minutes", () => {
    const previous: ChatTranscriptItem = {
      kind: "message",
      id: "a",
      role: "assistant",
      content: "a",
      created_at: now,
    };
    const current: ChatTranscriptItem = {
      kind: "message",
      id: "b",
      role: "assistant",
      content: "b",
      created_at: fiveMinutesLater,
    };
    expect(isContinuedMessage(previous, current)).toBe(true);
  });

  it("returns false for different roles", () => {
    const previous: ChatTranscriptItem = {
      kind: "message",
      id: "a",
      role: "user",
      content: "a",
      created_at: now,
    };
    const current: ChatTranscriptItem = {
      kind: "message",
      id: "b",
      role: "assistant",
      content: "b",
      created_at: fiveMinutesLater,
    };
    expect(isContinuedMessage(previous, current)).toBe(false);
  });

  it("returns false when gap exceeds 5 minutes", () => {
    const previous: ChatTranscriptItem = {
      kind: "message",
      id: "a",
      role: "assistant",
      content: "a",
      created_at: now,
    };
    const current: ChatTranscriptItem = {
      kind: "message",
      id: "b",
      role: "assistant",
      content: "b",
      created_at: sixMinutesLater,
    };
    expect(isContinuedMessage(previous, current)).toBe(false);
  });
});
