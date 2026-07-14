import { describe, expect, it } from "vitest";
import type { WorkItem, WorkflowSnapshot } from "../types/api";
import { workflowItemPositions } from "./layout";

function item(id: string, position: number): WorkItem {
  return {
    id,
    run_id: "run",
    position,
    objective: id,
    scenario_refs: ["scenario"],
    group: position < 3 ? "parallel" : null,
    scope_hints: [`src/${id}`],
    verification_goals: [],
    status: "pending",
    attempt_count: 0,
    actual_attempt_count: 0,
    version: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("workflowItemPositions", () => {
  it("stacks parallel roots and advances dependent work by longest path", () => {
    const workflow = {
      work_items: [
        item("w-01", 0),
        item("w-02", 1),
        item("w-04", 2),
        item("w-03", 3),
        item("w-05", 4),
      ],
      dependencies: [
        { work_item_id: "w-03", depends_on_id: "w-02" },
        { work_item_id: "w-05", depends_on_id: "w-03" },
        { work_item_id: "w-05", depends_on_id: "w-04" },
      ],
    } as WorkflowSnapshot;

    const positions = workflowItemPositions(workflow);
    const roots = ["w-01", "w-02", "w-04"].map((id) => positions.get(id)!);
    expect(new Set(roots.map((position) => position.x)).size).toBe(1);
    expect(new Set(roots.map((position) => position.y)).size).toBe(3);
    expect(positions.get("w-03")!.x).toBeGreaterThan(roots[0].x);
    expect(positions.get("w-05")!.x).toBeGreaterThan(positions.get("w-03")!.x);
  });
});
