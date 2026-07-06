// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../types/api";
import SessionTranscript from "./SessionTranscript";

function entry(cursor: number, role: string, text: string): SessionEntry {
  return {
    cursor,
    source: "测试会话",
    line: cursor + 1,
    kind: "message",
    id: `m-${cursor}`,
    role,
    timestamp: `2026-07-01T00:0${cursor}:00Z`,
    blocks: [{ type: "text", text }],
    raw: { type: "message", message: { role, content: text } },
  };
}

describe("SessionTranscript", () => {
  it("does not reload an empty transcript in a loop", async () => {
    const loadPage = vi.fn().mockResolvedValue({
      entries: [],
      next_before: null,
      invalid_lines: 0,
    });
    render(
      <SessionTranscript scopeKey="empty" loadPage={loadPage} initiallyOpen />,
    );

    expect(await screen.findByText("暂无匹配记录")).toBeInTheDocument();
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(1));
  });

  it("loads earlier entries, hides system, and exposes raw JSON", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [entry(1, "system", "system prompt"), entry(2, "user", "后")],
        next_before: 1,
        invalid_lines: 1,
      })
      .mockResolvedValueOnce({
        entries: [entry(0, "assistant", "前")],
        next_before: null,
        invalid_lines: 1,
      });
    render(
      <SessionTranscript scopeKey="test" loadPage={loadPage} initiallyOpen />,
    );

    expect(await screen.findByText("后")).toBeInTheDocument();
    expect(screen.queryByText("system prompt")).not.toBeInTheDocument();
    expect(screen.getByText("已跳过 1 条无效 JSONL")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    expect(await screen.findByText("前")).toBeInTheDocument();
    expect(loadPage).toHaveBeenLastCalledWith(1);

    fireEvent.click(screen.getAllByText("原始 JSON")[0]!);
    expect(screen.getByText(/"content": "前"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "system" }));
    expect(await screen.findByText("system prompt")).toBeInTheDocument();
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
  });
});
