import { describe, expect, it } from "vitest";
import type { Requirement, WorkflowSnapshot } from "../types/api";
import { buildWorkflowRunEdges } from "./edges";

const requirement = { id: "requirement-1" } as Requirement;

function workflow(): WorkflowSnapshot {
  return {
    run: {
      id: "run-1",
      requirement_id: requirement.id,
    } as WorkflowSnapshot["run"],
    work_items: [
      {
        id: "item-a",
        status: "accepted",
      } as WorkflowSnapshot["work_items"][number],
      {
        id: "item-b",
        status: "running",
      } as WorkflowSnapshot["work_items"][number],
      {
        id: "item-c",
        status: "pending",
      } as WorkflowSnapshot["work_items"][number],
    ],
    dependencies: [{ work_item_id: "item-b", depends_on_id: "item-a" }],
    attempts: [],
    checkpoints: [],
    validations: [],
    findings: [],
    last_event_sequence: 0,
  };
}

describe("buildWorkflowRunEdges", () => {
  it("connects the run entry and explicit dependencies without stage barriers", () => {
    const edges = buildWorkflowRunEdges(requirement, workflow());

    expect(
      edges.some((edge) => edge.id === "requirements-to-workflow-run"),
    ).toBe(true);
    expect(edges.some((edge) => edge.id === "workflow-entry-item-a")).toBe(
      true,
    );
    expect(edges.some((edge) => edge.id === "workflow-item-a-to-item-b")).toBe(
      true,
    );
    expect(edges.some((edge) => edge.id === "workflow-entry-item-c")).toBe(
      true,
    );
  });

  it("renders only the requirement-to-run edge before a WorkPlan exists", () => {
    const edges = buildWorkflowRunEdges(requirement, null);
    expect(edges).toHaveLength(1);
  });
});
