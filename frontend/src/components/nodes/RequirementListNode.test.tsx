// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  Requirement,
  RequirementExecutionTask,
  StartNodeData,
} from "../../types/api";
import RequirementListNode from "./RequirementListNode";

const now = "2026-06-25T00:00:00Z";

function task(): RequirementExecutionTask {
  return {
    id: "task-1",
    title: "task",
    description: "task",
    depends_on: [],
    kind: "implementation",
    model_tier: "medium",
    timeout_seconds: 60,
    pi_session_file: null,
    branch_name: null,
    worktree_path: null,
    review_for: null,
    review_angle: null,
    review_status: "pending",
    attempt: 0,
    execution_failure_count: 0,
    review_rejection_count: 0,
    recovery_stage: "none",
    failure_summary: null,
    recovery_guidance: null,
    high_tier_execution_used: false,
    last_review_feedback: null,
    pull_request_url: null,
    merged_into: null,
    cleanup_summary: null,
    execution_warning: null,
    trace: null,
    status: "completed",
    target_files: [],
    result_summary: null,
    error: null,
    review_history: [],
  };
}

function requirement(
  status: Requirement["status"],
  error: string | null = null,
  hasPlan = false,
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
    execution_plan: hasPlan ? { summary: "plan", tasks: [task()] } : null,
    error,
    created_at: now,
    updated_at: now,
  };
}

function data(
  pendingRequirements: Requirement[],
  completedRequirements: Requirement[] = [],
) {
  return {
    kind: "requirement-list",
    pendingRequirements,
    completedRequirements,
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
      screen.queryByRole("button", { name: /生成 DAG/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the regenerate action for a failed plan", () => {
    render(
      <RequirementListNode data={data([requirement("failed", "规划失败")])} />,
    );

    expect(
      screen.getByRole("button", { name: "重新生成 DAG" }),
    ).toBeInTheDocument();
  });

  it("switches between pending and completed requirements", () => {
    render(
      <RequirementListNode
        data={data(
          [requirement("queued")],
          [requirement("completed", null, true)],
        )}
      />,
    );

    expect(screen.getByText("queued requirement")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已完成 1" }));
    expect(screen.getByText("completed requirement")).toBeInTheDocument();
    expect(screen.getByText("查看 DAG")).toBeInTheDocument();
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
