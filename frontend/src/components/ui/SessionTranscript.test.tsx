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
    const { container } = render(
      <SessionTranscript scopeKey="test" loadPage={loadPage} initiallyOpen />,
    );

    expect(await screen.findByText("后")).toBeInTheDocument();
    expect(screen.queryByText("system prompt")).not.toBeInTheDocument();
    expect(screen.getByText("已跳过 1 条无效 JSONL")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    expect(await screen.findByText("前")).toBeInTheDocument();
    expect(loadPage).toHaveBeenLastCalledWith(1);

    fireEvent.click(screen.getAllByText("原始 JSON")[0]!);
    expect(container.textContent).toContain('"content": "前"');

    fireEvent.click(screen.getByRole("checkbox", { name: "system" }));
    expect(await screen.findByText("system prompt")).toBeInTheDocument();
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
  });

  it("shows v5 adaptive subagent selection, findings, usage, and diagnostics", async () => {
    const reviewEntry = entry(0, "toolResult", "parallel review");
    reviewEntry.blocks = [
      {
        type: "subagents",
        selection: {
          classification: "source",
          angles: ["正确性", "代码质量与测试"],
          skippedAngles: ["边界与安全"],
          reasons: ["普通源码、样式或本地化改动"],
          focus: "行为和测试",
          fileCount: 1,
          changedLines: 2,
          diffBytes: 100,
        },
        reviews: [
          {
            angle: "正确性",
            transport_status: "completed",
            result: {
              findings: [
                {
                  priority: "P2",
                  category: "maintainability",
                  path: "src/main.rs",
                  location: "main",
                  summary: "可进一步精简",
                  evidence: "不影响行为",
                },
              ],
            },
            usage: {
              input: 11,
              output: 2,
              cacheRead: 3,
              cacheWrite: 4,
              context: { tokens: 10, window: 100, percent: 10 },
            },
            events: [
              { type: "tool_execution_start", toolName: "read_staged_diff" },
              { type: "technical_retry" },
            ],
            turns: 2,
            retry_count: 1,
            submission_correction_count: 1,
            duration_ms: 1500,
            runtime: {
              warningAfterMs: 60000,
              idleTimeoutMs: 300000,
              activityCount: 4,
              idleWarningCount: 1,
              maxIdleMs: 61000,
              absoluteTimeout: false,
            },
            session_persisted: false,
            events_truncated: true,
          },
        ],
      },
    ];
    const loadPage = vi.fn().mockResolvedValue({
      entries: [reviewEntry],
      next_before: null,
      invalid_lines: 0,
    });
    render(
      <SessionTranscript
        scopeKey="subagents"
        loadPage={loadPage}
        initiallyOpen
      />,
    );

    fireEvent.click(await screen.findByText(/隔离审核子代理/));
    expect(screen.getByText("风险分类：source")).toBeInTheDocument();
    expect(screen.getByText(/跳过：边界与安全/)).toBeInTheDocument();
    expect(screen.getByText(/P2 · 可进一步精简/)).toBeInTheDocument();
    expect(screen.getByText(/空闲阈值/)).toHaveTextContent(
      "300s · 活动 4 次 · 空闲告警 1 次",
    );
    expect(await screen.findByText(/Context 10.0%/)).toHaveTextContent(
      "2 turns · 1 次技术重试 · 1 次结构纠正 · 1.5s",
    );
    expect(
      screen.getByText("调试事件已截断，结构化结论不受影响。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("精简过程 (2)"));
    expect(
      await screen.findByText(/调用 read_staged_diff/),
    ).toBeInTheDocument();
    expect(screen.getByText(/开始单角度重试/)).toBeInTheDocument();
  });

  it("shows the real persisted compaction shape without exposing its summary", async () => {
    const compaction: SessionEntry = {
      cursor: 0,
      source: "项目问答",
      line: 1,
      kind: "compaction",
      id: "compact-1",
      role: null,
      timestamp: "2026-07-01T00:00:00Z",
      blocks: [
        {
          type: "compaction",
          reason: null,
          status: "completed",
          tokens_before: 12_000,
          estimated_tokens_after: null,
          estimated_tokens_saved: null,
          first_kept_entry_id: "message-42",
          from_hook: false,
          read_file_count: 2,
          modified_file_count: 1,
          will_retry: false,
          error: null,
          usage_known: false,
        },
      ],
      raw: {
        type: "compaction",
        firstKeptEntryId: "message-42",
        tokensBefore: 12_000,
        details: {
          readFiles: ["src/main.rs", "src/pi/mod.rs"],
          modifiedFiles: ["src/pi/mod.rs"],
        },
      },
    };
    const loadPage = vi.fn().mockResolvedValue({
      entries: [compaction],
      next_before: null,
      invalid_lines: 0,
    });

    render(
      <SessionTranscript
        scopeKey="compaction"
        loadPage={loadPage}
        initiallyOpen
      />,
    );

    expect(await screen.findByText("压缩完成 · Pi 原生")).toBeInTheDocument();
    expect(screen.getByText("压缩前 12,000 tokens")).toBeInTheDocument();
    expect(screen.getByText(/文件上下文：读取 2 · 修改 1/)).toBeInTheDocument();
    expect(screen.getByText(/Pi session 未保存压缩后估算/)).toHaveTextContent(
      "供应商 usage 未提供",
    );
    expect(screen.queryByText("原始 JSON")).not.toBeInTheDocument();
  });
});
