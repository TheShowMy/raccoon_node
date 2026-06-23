import { describe, expect, it } from "vitest";
import { getTaskLayout } from "./layout";
import type { RequirementExecutionTask } from "../types/api";

function task(
  id: string,
  dependsOn: string[] = [],
  kind: RequirementExecutionTask["kind"] = "implementation",
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
  };
}

describe("canvas task layout", () => {
  it("places dependent external tasks in later columns", () => {
    const layout = getTaskLayout([
      task("a"),
      task("review-a", ["a"], "review_summary"),
      task("b", ["a"], "branch_merge"),
      task("c", ["b"], "merge_review"),
    ]);

    expect(layout.get("b")?.x).toBeGreaterThan(layout.get("a")?.x ?? 0);
    expect(layout.get("c")?.x).toBeGreaterThan(layout.get("b")?.x ?? 0);
    expect(layout.has("review-a")).toBe(false);
  });
});
