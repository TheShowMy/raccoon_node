import { describe, expect, it } from "vitest";
import {
  DAG_NODE_POSITION,
  DAG_NODE_SIZE,
  getTaskGroupChildSize,
  getTaskGroupLayout,
  getTaskLayout,
  getTaskNodeSize,
  TASK_COLUMN_GAP,
} from "./layout";
import type { RequirementExecutionTask } from "../types/api";

function task(
  id: string,
  dependsOn: string[] = [],
  kind: RequirementExecutionTask["kind"] = "implementation",
  extra: Partial<RequirementExecutionTask> = {},
): RequirementExecutionTask {
  return {
    id,
    title: id,
    description: id,
    depends_on: dependsOn,
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
    ...extra,
  };
}

describe("canvas task layout", () => {
  it("keeps a consistent gap after the DAG and different-width tasks", () => {
    const layout = getTaskLayout([
      task("a"),
      task("review-a", ["a"], "review_summary"),
      task("b", ["a"], "branch_merge"),
      task("c", ["b"]),
    ]);

    expect(layout.get("a")?.x).toBe(
      DAG_NODE_POSITION.x + DAG_NODE_SIZE.width + TASK_COLUMN_GAP,
    );
    expect(
      (layout.get("b")?.x ?? 0) -
        (layout.get("a")?.x ?? 0) -
        getTaskNodeSize(task("a")).width,
    ).toBe(TASK_COLUMN_GAP);
    expect(
      (layout.get("c")?.x ?? 0) -
        (layout.get("b")?.x ?? 0) -
        getTaskNodeSize(task("b", ["a"], "branch_merge")).width,
    ).toBe(TASK_COLUMN_GAP);
    expect(layout.has("review-a")).toBe(false);
  });

  it("uses the widest node when advancing to the next column", () => {
    const layout = getTaskLayout([
      task("implementation"),
      task("merge", [], "branch_merge"),
      task("next", ["implementation", "merge"]),
    ]);

    expect(layout.get("next")?.x).toBe(
      (layout.get("implementation")?.x ?? 0) +
        getTaskNodeSize(task("implementation")).width +
        TASK_COLUMN_GAP,
    );
  });

  it("lays out code, summary, and review nodes in three columns", () => {
    const code = task("implementation");
    const subAgents = Array.from({ length: 3 }, (_, index) =>
      task(`review-${index}`, ["implementation"], "review_sub_agent", {
        review_for: "implementation",
      }),
    );
    const summary = task(
      "summary",
      subAgents.map((review) => review.id),
      "review_summary",
      { review_for: "implementation" },
    );
    const layout = getTaskGroupLayout(code, [...subAgents, summary]);
    const codePosition = layout.positions.get(code.id)!;
    const summaryPosition = layout.positions.get(summary.id)!;

    expect(codePosition.x).toBeLessThan(summaryPosition.x);
    expect(summaryPosition.x).toBeLessThan(layout.positions.get("review-0")!.x);
    expect(layout.positions.get("review-0")!.x).toBe(
      layout.positions.get("review-1")!.x,
    );
    expect(layout.positions.get("review-1")!.x).toBe(
      layout.positions.get("review-2")!.x,
    );

    for (const review of [code, ...subAgents, summary]) {
      const position = layout.positions.get(review.id)!;
      const size = getTaskGroupChildSize(review);
      expect(position.x + size.width).toBeLessThanOrEqual(layout.width);
      expect(position.y + size.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("falls back to placing review nodes after code when summary is absent", () => {
    const code = task("implementation");
    const review = task("review", ["implementation"], "review_sub_agent", {
      review_for: "implementation",
    });
    const layout = getTaskGroupLayout(code, [review]);

    expect(layout.positions.get(review.id)!.x).toBeGreaterThan(
      layout.positions.get(code.id)!.x,
    );
  });
});
