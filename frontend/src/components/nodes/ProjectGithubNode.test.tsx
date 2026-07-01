// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

  it("shows local publication without GitHub prerequisites", () => {
    render(
      <ProjectGithubNode
        data={{
          kind: "project-github",
          project: { ...project, git_url: "" },
          publicationReadiness: {
            mode: "local",
            ready: true,
            summary: "使用本地合并",
            issues: [],
            notes: [],
          },
        }}
      />,
    );

    expect(screen.getByText("本地发布")).toBeInTheDocument();
    expect(screen.getByText("无需 PR")).toBeInTheDocument();
  });

  it("shows blocking publication prerequisites and restart guidance", () => {
    render(
      <ProjectGithubNode
        data={{
          kind: "project-github",
          project,
          publicationReadiness: {
            mode: "pull_request",
            ready: false,
            summary: "PR 发布前置检查未通过，任务执行已阻止。",
            issues: ["GitHub CLI 未登录，请执行 gh auth login。"],
            notes: ["需要推送和合并权限。"],
          },
        }}
      />,
    );

    expect(screen.getByText("1 项待处理")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /PR 发布/ }));
    expect(screen.getByText(/gh auth login/)).toBeInTheDocument();
    expect(screen.getByText(/处理完成后请重启应用/)).toBeInTheDocument();
  });
});
