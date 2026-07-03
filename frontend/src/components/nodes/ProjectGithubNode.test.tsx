// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectGithubNode from "./ProjectGithubNode";

describe("ProjectGithubNode", () => {
  const project = {
    id: "current",
    name: "repo",
    git_url: "git@github.com:acme/repo.git",
    local_path: "/repo",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  };

  function data(
    overrides: Partial<
      Extract<
        import("../../types/api").StartNodeData,
        { kind: "project-github" }
      >
    > = {},
  ) {
    return {
      kind: "project-github" as const,
      expanded: false,
      project,
      publicationReadiness: {
        mode: "local" as const,
        ready: true,
        summary: "使用本地合并",
        issues: [],
        notes: [],
      },
      onToggleExpanded: vi.fn(),
      ...overrides,
    };
  }

  it("shows local publication without GitHub prerequisites", () => {
    render(
      <ProjectGithubNode
        data={data({ project: { ...project, git_url: "" } })}
      />,
    );

    expect(screen.getByText("本地发布")).toBeInTheDocument();
    expect(screen.getByText("无需 PR")).toBeInTheDocument();
  });

  it("shows blocking publication prerequisites and calls expand", () => {
    const props = data({
      publicationReadiness: {
        mode: "pull_request",
        ready: false,
        summary: "PR 发布前置检查未通过，任务执行已阻止。",
        issues: ["GitHub CLI 未登录，请执行 gh auth login。"],
        notes: ["需要推送和合并权限。"],
      },
    });
    render(<ProjectGithubNode data={props} />);

    expect(screen.getByText("1 项待处理")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /PR 发布/ }));
    expect(props.onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("renders expanded panel with issues, notes and GitHub link", () => {
    render(
      <ProjectGithubNode
        data={data({
          expanded: true,
          publicationReadiness: {
            mode: "pull_request",
            ready: false,
            summary: "PR 发布前置检查未通过，任务执行已阻止。",
            issues: ["GitHub CLI 未登录，请执行 gh auth login。"],
            notes: ["需要推送和合并权限。"],
          },
        })}
      />,
    );

    expect(screen.getByText(/gh auth login/)).toBeInTheDocument();
    expect(screen.getByText(/处理完成后请重启应用/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "打开 GitHub 仓库" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/repo");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
