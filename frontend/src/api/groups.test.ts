import { describe, expect, it } from "vitest";
import { groupRequirement, groupRequirements } from "./groups";
import type { Requirement, Run } from "./types";

function requirement(
  partial: Partial<Requirement> & Pick<Requirement, "id" | "state">,
): Requirement {
  return {
    title: partial.id,
    source_session_id: "s-main",
    source_branch_id: "b-main",
    source_node_ids: [],
    latest_revision: 0,
    confirmed_revision: null,
    queue_position: null,
    latest_run_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function run(partial: Partial<Run> & Pick<Run, "id" | "phase">): Run {
  return {
    requirement_id: "req-x",
    requirement_revision: 1,
    resume_phase: null,
    outcome: null,
    blocked_reason: null,
    cancel_reason: null,
    current_activity: null,
    publication_path: "github_pull_request",
    publication_frozen_reason: "",
    task_budget_usd: 25,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("需求分组投影（FE-DELIVERY-002、PRD §8.1）", () => {
  it("只投影已经确认或曾经执行的需求", () => {
    const cases: [Requirement, Run | null, string | null][] = [
      [requirement({ id: "r1", state: "drafting" }), null, null],
      [requirement({ id: "r2", state: "clarifying" }), null, null],
      [requirement({ id: "r3", state: "spec_ready" }), null, null],
      [
        requirement({
          id: "r4",
          state: "queued",
          confirmed_revision: 1,
        }),
        null,
        "queued",
      ],
      [
        requirement({ id: "r5", state: "queued", latest_run_id: "run-1" }),
        run({ id: "run-1", phase: "executing" }),
        "active",
      ],
      [
        requirement({ id: "r6", state: "queued", latest_run_id: "run-2" }),
        run({ id: "run-2", phase: "waiting_workspace" }),
        "active",
      ],
      [
        requirement({ id: "r7", state: "queued", latest_run_id: "run-3" }),
        run({ id: "run-3", phase: "terminal", outcome: "delivered" }),
        "history",
      ],
      [
        requirement({ id: "r8", state: "queued", latest_run_id: "run-4" }),
        run({ id: "run-4", phase: "blocked" }),
        "blocked",
      ],
      [
        requirement({ id: "r9", state: "queued", latest_run_id: "run-5" }),
        run({ id: "run-5", phase: "terminal", outcome: "failed" }),
        "history",
      ],
      [
        requirement({ id: "r10", state: "spec_ready", latest_run_id: "run-6" }),
        run({ id: "run-6", phase: "terminal", outcome: "cancelled" }),
        "history",
      ],
      [requirement({ id: "r11", state: "cancelled" }), null, null],
      [
        requirement({
          id: "r12",
          state: "superseded",
          confirmed_revision: 1,
        }),
        null,
        "history",
      ],
    ];
    for (const [req, latestRun, expected] of cases) {
      expect(groupRequirement(req, latestRun), req.id).toBe(expected);
    }
  });

  it("分组顺序固定且排队组内按 queue_position 排序", () => {
    const requirements = [
      requirement({
        id: "q2",
        state: "queued",
        queue_position: 2,
        confirmed_revision: 1,
      }),
      requirement({ id: "d1", state: "drafting" }),
      requirement({
        id: "q1",
        state: "queued",
        queue_position: 1,
        confirmed_revision: 1,
      }),
      requirement({ id: "s1", state: "spec_ready" }),
    ];
    const groups = groupRequirements(requirements, {});
    expect(groups.map((group) => group.key)).toEqual(["queued"]);
    const queued = groups.find((group) => group.key === "queued")!;
    expect(queued.items.map((item) => item.id)).toEqual(["q1", "q2"]);
  });
});
