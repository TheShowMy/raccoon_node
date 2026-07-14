import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "../types/api";
import {
  MAIN_NODE_Y,
  REQUIREMENT_CHAT_NODE_SIZE,
  REQUIREMENT_LIST_NODE_SIZE,
  WORKFLOW_RUN_NODE_SIZE,
  mainNodePositions,
  workflowItemPositions,
} from "./layout";

function workflowSnapshot(
  items: Array<{ id: string; depends_on?: string[] }>,
): WorkflowSnapshot {
  const now = "2026-07-13T00:00:00Z";
  return {
    run: {
      id: "run-1",
      requirement_id: "req-1",
      status: "running",
      change_spec: {
        intent: "测试布局",
        acceptance_scenarios: [],
        explicit_constraints: [],
        non_goals: [],
      },
      design_notes: [],
      plan_summary: "测试",
      source_revision: 1,
      rescue_used: false,
      created_at: now,
      updated_at: now,
    },
    work_items: items.map((item, index) => ({
      id: item.id,
      run_id: "run-1",
      position: index,
      objective: `item ${item.id}`,
      scenario_refs: [],
      scope_hints: [],
      verification_goals: [],
      status: "pending",
      attempt_count: 0,
      actual_attempt_count: 0,
      created_at: now,
      updated_at: now,
    })),
    dependencies: items.flatMap((item) =>
      (item.depends_on ?? []).map((depends_on_id) => ({
        work_item_id: item.id,
        depends_on_id,
      })),
    ),
    attempts: [],
    checkpoints: [],
    validations: [],
    findings: [],
    last_event_sequence: 0,
  };
}

describe("mainNodePositions", () => {
  it("aligns all main nodes to the same horizontal axis", () => {
    const positions = mainNodePositions();
    expect(positions["requirement-chat"].y).toBe(MAIN_NODE_Y);
    expect(positions["requirement-list"].y).toBe(MAIN_NODE_Y);
    expect(positions["workflow-run"].y).toBe(MAIN_NODE_Y);
  });

  it("places nodes left-to-right with consistent gaps", () => {
    const positions = mainNodePositions();
    const listLeft = positions["requirement-list"].x;
    const chatRight =
      positions["requirement-chat"].x + REQUIREMENT_CHAT_NODE_SIZE.width;
    const runLeft = positions["workflow-run"].x;
    const listRight = listLeft + REQUIREMENT_LIST_NODE_SIZE.width;

    expect(listLeft - chatRight).toBeGreaterThan(0);
    expect(runLeft - listRight).toBe(listLeft - chatRight);
  });
});

describe("workflowItemPositions", () => {
  it("centers a single independent item vertically around the workflow-run node", () => {
    const positions = workflowItemPositions(workflowSnapshot([{ id: "a" }]));
    const runPosition = mainNodePositions()["workflow-run"];
    const centerY = runPosition.y + WORKFLOW_RUN_NODE_SIZE.height / 2;
    const itemY = positions.get("a")!.y;
    expect(itemY + 110).toBe(centerY);
  });

  it("symmetrically distributes two items in the same rank", () => {
    const positions = workflowItemPositions(
      workflowSnapshot([{ id: "a" }, { id: "b" }]),
    );
    const runPosition = mainNodePositions()["workflow-run"];
    const centerY = runPosition.y + WORKFLOW_RUN_NODE_SIZE.height / 2;
    const aCenter = positions.get("a")!.y + 110;
    const bCenter = positions.get("b")!.y + 110;
    expect(aCenter + bCenter).toBe(centerY * 2);
  });

  it("symmetrically distributes three items in the same rank", () => {
    const positions = workflowItemPositions(
      workflowSnapshot([{ id: "a" }, { id: "b" }, { id: "c" }]),
    );
    const runPosition = mainNodePositions()["workflow-run"];
    const centerY = runPosition.y + WORKFLOW_RUN_NODE_SIZE.height / 2;
    const aCenter = positions.get("a")!.y + 110;
    const bCenter = positions.get("b")!.y + 110;
    const cCenter = positions.get("c")!.y + 110;
    expect(bCenter).toBe(centerY);
    expect(aCenter + cCenter).toBe(centerY * 2);
  });

  it("places dependent items in the next rank to the right", () => {
    const positions = workflowItemPositions(
      workflowSnapshot([{ id: "a" }, { id: "b", depends_on: ["a"] }]),
    );
    const aX = positions.get("a")!.x;
    const bX = positions.get("b")!.x;
    expect(bX).toBeGreaterThan(aX);
  });

  it("keeps items in the same rank aligned vertically with equal spacing", () => {
    const positions = workflowItemPositions(
      workflowSnapshot([{ id: "a" }, { id: "b" }]),
    );
    const aX = positions.get("a")!.x;
    const bX = positions.get("b")!.x;
    expect(aX).toBe(bX);
  });
});
