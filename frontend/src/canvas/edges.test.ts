import { describe, expect, it } from "vitest";
import { buildRequirementDagEdges } from "./edges";
import type { Requirement, RequirementExecutionTask } from "../types/api";

function task(
  id: string,
  kind: RequirementExecutionTask["kind"],
  extra: Partial<RequirementExecutionTask> = {},
): RequirementExecutionTask {
  return {
    id,
    title: id,
    description: id,
    depends_on: [],
    kind,
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
    status: "pending",
    target_files: [],
    result_summary: null,
    error: null,
    review_history: [],
    ...extra,
  };
}

function requirement(tasks: RequirementExecutionTask[]): Requirement {
  return {
    id: "req",
    project_id: "project",
    title: "req",
    original_message: "req",
    origin: "standalone",
    status: "running",
    messages: [],
    clarification_round: 0,
    clarifications: [],
    draft: null,
    execution_plan: { summary: "plan", tasks },
    error: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

function requirementWithStatus(
  status: Requirement["status"],
  tasks: RequirementExecutionTask[] = [task("impl", "implementation")],
): Requirement {
  return {
    ...requirement(tasks),
    status,
  };
}

describe("canvas DAG edges", () => {
  it("always connects the merged requirements node to the DAG", () => {
    for (const status of ["queued", "completed"] as const) {
      const edges = buildRequirementDagEdges(
        requirementWithStatus(status),
        new Set(),
      );

      expect(edges[0]).toMatchObject({
        id: "requirements-to-requirement-dag",
        source: "requirements",
        sourceHandle: "requirement-list-right",
        target: "requirement-dag",
        targetHandle: "requirement-dag-left",
      });
    }
  });

  it("builds display-only edges through the summary for all review nodes", () => {
    const edges = buildRequirementDagEdges(
      requirement([
        task("impl", "implementation"),
        task("review-a", "review_sub_agent", {
          review_for: "impl",
          depends_on: ["unrelated-a"],
        }),
        task("review-b", "review", {
          review_for: "impl",
          depends_on: [],
        }),
        task("review-c", "review_sub_agent", {
          review_for: "impl",
          depends_on: ["review-a"],
        }),
        task("summary", "review_summary", {
          review_for: "impl",
          depends_on: ["unrelated-summary"],
        }),
      ]),
      new Set(),
    );

    const internalEdges = edges.filter((edge) =>
      edge.id.startsWith("requirement-task-"),
    );

    expect(
      internalEdges.map(({ source, target }) => ({ source, target })),
    ).toEqual([
      {
        source: "requirement-task-impl",
        target: "requirement-task-summary",
      },
      {
        source: "requirement-task-summary",
        target: "requirement-task-review-a",
      },
      {
        source: "requirement-task-summary",
        target: "requirement-task-review-b",
      },
      {
        source: "requirement-task-summary",
        target: "requirement-task-review-c",
      },
    ]);
    expect(
      internalEdges.every((edge) => edge.markerStart && edge.markerEnd),
    ).toBe(true);
  });

  it("connects code to a summary that has no review nodes", () => {
    const edges = buildRequirementDagEdges(
      requirement([
        task("impl", "implementation", {
          depends_on: ["external-dependency"],
        }),
        task("summary", "review_summary", {
          review_for: "impl",
          depends_on: [],
        }),
      ]),
      new Set(),
    );

    const internalEdges = edges.filter((edge) =>
      edge.id.startsWith("requirement-task-"),
    );

    expect(internalEdges).toHaveLength(1);
    expect(internalEdges[0]).toMatchObject({
      source: "requirement-task-impl",
      target: "requirement-task-summary",
    });
    expect(internalEdges[0].markerStart).toBeDefined();
    expect(internalEdges[0].markerEnd).toBeDefined();
  });

  it("skips implementation internal edges when its group is collapsed", () => {
    const edges = buildRequirementDagEdges(
      requirement([
        task("impl", "implementation"),
        task("review", "review_sub_agent", {
          review_for: "impl",
          depends_on: ["impl"],
        }),
        task("summary", "review_summary", {
          review_for: "impl",
          depends_on: ["review"],
        }),
      ]),
      new Set(["req:impl"]),
    );

    expect(edges.some((edge) => edge.id.startsWith("requirement-task-"))).toBe(
      false,
    );
    expect(
      edges.some((edge) => edge.target === "requirement-task-group-impl"),
    ).toBe(true);
  });
});
