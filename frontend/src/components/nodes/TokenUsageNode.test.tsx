// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import TokenUsageNode from "./TokenUsageNode";

function data(
  overrides: Partial<Extract<StartNodeData, { kind: "token-usage" }>> = {},
) {
  return {
    kind: "token-usage" as const,
    usage: {
      chat: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
      split: { input: 5, output: 6, cache_read: 7, cache_write: 8 },
      task: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
      total: { input: 16, output: 28, cache_read: 40, cache_write: 52 },
    },
    expanded: false,
    onToggleExpanded: vi.fn(),
    ...overrides,
  };
}

describe("TokenUsageNode", () => {
  it("shows total tokens in collapsed bar", () => {
    render(<TokenUsageNode data={data()} />);

    expect(screen.getByText("Token 使用 · 136 total")).toBeInTheDocument();
  });

  it("calls onToggleExpanded when clicked", () => {
    const props = data();
    render(<TokenUsageNode data={props} />);

    fireEvent.click(screen.getByRole("button", { name: /Token 使用/ }));
    expect(props.onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("shows category totals when expanded", () => {
    render(<TokenUsageNode data={data({ expanded: true })} />);

    expect(screen.getByText("对话")).toBeInTheDocument();
    expect(screen.getByText("拆分任务")).toBeInTheDocument();
    expect(screen.getByText("任务")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("26")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
  });

  it("marks the expanded scrollable area with nodrag and nowheel", () => {
    render(<TokenUsageNode data={data({ expanded: true })} />);
    const scrollable = document.querySelector(".astryx-stack.nodrag.nowheel");
    expect(scrollable).toBeInTheDocument();
  });
});
