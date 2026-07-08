// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectGitNode from "./ProjectGitNode";

const status = {
  branch: "main",
  head: "abc",
  upstream: "origin/main",
  ahead: 2,
  behind: 0,
  branches: ["main", "feature"],
  remote_configured: true,
  write_blocked: false,
  blocked_reason: null,
  files: [
    {
      path: "src/main.rs",
      original_path: null,
      staged: "modified" as const,
      unstaged: null,
    },
    {
      path: "README.md",
      original_path: null,
      staged: null,
      unstaged: "modified" as const,
    },
  ],
};

function renderNode(phase: "collapsed" | "expanded" = "expanded") {
  const onToggleExpanded = vi.fn();
  const onAction = vi.fn(async () => true);
  render(
    <ProjectGitNode
      data={{
        kind: "project-git",
        phase,
        status,
        diff: null,
        selectedPaths: new Set(),
        selectedDiff: null,
        busy: false,
        error: null,
        lastResult: null,
        onToggleExpanded,
        onRefresh: async () => {},
        onTogglePath: () => {},
        onSelectDiff: async () => {},
        onAction,
      }}
    />,
  );
  return { onAction, onToggleExpanded };
}

describe("ProjectGitNode", () => {
  it("shows branch and change summary while collapsed", () => {
    const { onToggleExpanded } = renderNode("collapsed");
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText(/2 个变更/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /main/ }));
    expect(onToggleExpanded).toHaveBeenCalled();
  });

  it("requires confirmation before commit", async () => {
    const { onAction } = renderNode();
    fireEvent.change(screen.getByLabelText("提交信息"), {
      target: { value: "feat: git node" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(screen.getByText("确认提交")).toBeInTheDocument();
    expect(
      screen.getByText("向 main 提交 1 个文件：feat: git node"),
    ).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith(
        {
          type: "commit",
          message: "feat: git node",
          confirmed: true,
        },
        "提交完成",
      ),
    );
  });

  it("disables Git writes when the backend blocks them", () => {
    render(
      <ProjectGitNode
        data={{
          kind: "project-git",
          phase: "expanded",
          status: {
            ...status,
            write_blocked: true,
            blocked_reason: "任务执行中",
          },
          diff: null,
          selectedPaths: new Set(),
          selectedDiff: null,
          busy: false,
          error: null,
          lastResult: null,
          onToggleExpanded: () => {},
          onRefresh: async () => {},
          onTogglePath: () => {},
          onSelectDiff: async () => {},
          onAction: async () => true,
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();
    expect(screen.getByText("任务执行中")).toBeInTheDocument();
  });
});
