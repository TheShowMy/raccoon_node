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
      input: 10,
      output: 20,
      cache_read: 30,
      cache_write: 40,
      context_tokens: 50,
      context_window: 100,
      context_percent: 50,
    },
    expanded: false,
    onToggleExpanded: vi.fn(),
    ...overrides,
  };
}

describe("TokenUsageNode", () => {
  it("shows total tokens in collapsed bar", () => {
    render(<TokenUsageNode data={data()} />);

    expect(screen.getByText("Token 使用 · 100 total")).toBeInTheDocument();
  });

  it("calls onToggleExpanded when clicked", () => {
    const props = data();
    render(<TokenUsageNode data={props} />);

    fireEvent.click(screen.getByRole("button", { name: /Token 使用/ }));
    expect(props.onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("shows all fields when expanded", () => {
    render(<TokenUsageNode data={data({ expanded: true })} />);

    expect(screen.getByText("输入")).toBeInTheDocument();
    expect(screen.getByText("输出")).toBeInTheDocument();
    expect(screen.getByText("缓存读")).toBeInTheDocument();
    expect(screen.getByText("缓存写")).toBeInTheDocument();
  });
});
