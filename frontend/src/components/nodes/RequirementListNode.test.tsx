// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
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
    status,
    messages: [],
    clarification_round: 0,
    clarifications: [],
    draft: null,
    execution_plan: null,
    pi_session_file: null,
    error,
    created_at: now,
    updated_at: now,
  };
}

function data(requirements: Requirement[]) {
  return {
    kind: "requirement-list",
    title: "待执行 / 执行中",
    description: `${requirements.length} 个`,
    requirements,
    emptyText: "暂无需求",
    tone: "pending",
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
});
