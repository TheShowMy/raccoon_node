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
    commit_sha: null,
    review_for: null,
    review_angle: null,
    review_status: "pending",
    attempt: 0,
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
    ...extra,
  };
}

function requirement(tasks: RequirementExecutionTask[]): Requirement {
  return {
    id: "req",
    project_id: "project",
    title: "req",
    original_message: "req",
    status: "running",
    messages: [],
    clarification_round: 0,
    clarifications: [],
    draft: null,
    execution_plan: { summary: "plan", tasks },
    pi_session_file: null,
    error: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

describe("canvas DAG edges", () => {
  it("skips implementation internal edges when its group is collapsed", () => {
    const edges = buildRequirementDagEdges(
      requirement([
        task("impl", "implementation"),
        task("summary", "review_summary", { review_for: "impl" }),
        task("review", "review_sub_agent", { review_for: "impl" }),
      ]),
      new Set(["req:impl"]),
    );

    expect(
      edges.some((edge) => edge.id === "requirement-task-impl-to-summary"),
    ).toBe(false);
    expect(
      edges.some((edge) => edge.target === "requirement-task-group-impl"),
    ).toBe(true);
  });
});
