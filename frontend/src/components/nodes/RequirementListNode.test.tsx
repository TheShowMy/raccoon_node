// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Requirement, StartNodeData } from "../../types/api";
import RequirementListNode from "./RequirementListNode";

const now = "2026-06-25T00:00:00Z";

function requirement(
  status: Requirement["status"],
  error: string | null = null,
): Requirement {
  return {
    id: status,
    project_id: "project-1",
    title: `${status} requirement`,
    original_message: "test",
    origin: "standalone",
    status,
    messages: [],
    clarification_round: 0,
    clarifications: [],
    draft: null,
    error,
    created_at: now,
    updated_at: now,
  };
}

function data(
  pendingRequirements: Requirement[],
  completedRequirements: Requirement[] = [],
  workflowRequirementIds = new Set<string>(),
) {
  return {
    kind: "requirement-list",
    pendingRequirements,
    completedRequirements,
    workflowRequirementIds,
    selectedRequirementId: null,
    busyRequirementId: null,
    onSelectRequirement: vi.fn(),
    onPlanRequirement: vi.fn(),
  } satisfies Extract<StartNodeData, { kind: "requirement-list" }>;
}

describe("RequirementListNode", () => {
  it("does not show a planning action for an ordinary queued requirement", () => {
    render(<RequirementListNode data={data([requirement("queued")])} />);

    expect(
      screen.queryByRole("button", { name: /生成 WorkPlan/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the regenerate action for a failed plan", () => {
    render(
      <RequirementListNode data={data([requirement("failed", "规划失败")])} />,
    );

    expect(
      screen.getByRole("button", { name: "重新生成 WorkPlan" }),
    ).toBeInTheDocument();
  });

  it("switches between pending and completed requirements", () => {
    render(
      <RequirementListNode
        data={data(
          [requirement("queued")],
          [requirement("completed", null)],
          new Set(["completed"]),
        )}
      />,
    );

    expect(screen.getByText("queued requirement")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已完成 1" }));
    expect(screen.getByText("completed requirement")).toBeInTheDocument();
    expect(screen.getByText("查看 WorkflowRun")).toBeInTheDocument();
  });

  it("shows separate empty states for each tab", () => {
    render(<RequirementListNode data={data([], [])} />);

    expect(screen.getByText("确认需求后会进入这里")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已完成 0" }));
    expect(screen.getByText("暂无已完成需求")).toBeInTheDocument();
  });

  it("marks the requirement list scrollable area with nodrag and nowheel", () => {
    render(<RequirementListNode data={data([requirement("queued")])} />);
    const list = document.querySelector(".astryx-stack.nodrag.nowheel");
    expect(list).toBeInTheDocument();
  });
});
