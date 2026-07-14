import { describe, expect, it } from "vitest";
import type {
  Project,
  ProjectCanvasData,
  Requirement,
  WorkflowSnapshot,
} from "../types/api";
import {
  buildProjectNodes,
  buildWorkflowRunEdges,
  type BuildProjectNodesParams,
} from "./buildProjectNodes";

const now = new Date(0).toISOString();

function project(): Project {
  return {
    id: "current",
    name: "Project",
    git_url: "https://example.com/repo.git",
    local_path: "/tmp/repo",
    created_at: now,
    updated_at: now,
  };
}

function requirement(): Requirement {
  return {
    id: "requirement-1",
    project_id: "current",
    title: "WorkflowRun",
    original_message: "refactor",
    origin: "standalone",
    status: "running",
    messages: [],
    clarification_round: 0,
    clarifications: [],
    draft: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
}

function workflow(itemCount = 2): WorkflowSnapshot {
  return {
    run: {
      id: "run-1",
      requirement_id: "requirement-1",
      project_id: "current",
      status: "running",
      change_spec: {
        intent: "WorkflowRun",
        acceptance_scenarios: [
          { id: "b1", given: "已有项目", when: "执行需求", then: "行为生效" },
        ],
        explicit_constraints: [],
        non_goals: [],
      },
      design_notes: [],
      plan_summary: "真实工作计划",
      source_revision: 1,
      rescue_used: false,
      version: 0,
      created_at: now,
      updated_at: now,
    },
    work_items: Array.from({ length: itemCount }, (_, index) => ({
      id: `item-${index}`,
      run_id: "run-1",
      position: index,
      objective: `工作项 ${index}`,
      scenario_refs: ["b1"],
      group: null,
      scope_hints: [`src/${index}.rs`],
      verification_goals: ["行为生效"],
      status: index === 0 ? "running" : "pending",
      attempt_count: index === 0 ? 1 : 0,
      actual_attempt_count: index === 0 ? 1 : 0,
      version: 0,
      created_at: now,
      updated_at: now,
    })),
    dependencies: Array.from(
      { length: Math.max(0, itemCount - 1) },
      (_, index) => ({
        work_item_id: `item-${index + 1}`,
        depends_on_id: `item-${index}`,
      }),
    ),
    attempts: [],
    checkpoints: [],
    validations: [],
    findings: [],
    last_event_sequence: 0,
  };
}

function params(canvas: ProjectCanvasData): BuildProjectNodesParams {
  const selected = canvas.active_requirement;
  return {
    projectCanvas: canvas,
    project: canvas.project,
    selectedWorkflowRequirement: selected,
    selectedWorkflowRequirementId: selected?.id ?? null,
    requirementActionBusyId: null,
    requirementActionError: null,
    tokenUsageExpanded: false,
    closeWorkflow: () => {},
    selectWorkflowRequirement: () => {},
    planRequirement: async () => {},
    onToggleTokenUsageExpanded: () => {},
  };
}

describe("buildProjectNodes WorkflowRun", () => {
  it("renders only real work items for the selected WorkflowRun", () => {
    const selected = requirement();
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: selected,
      queued_requirements: [],
      completed_requirements: [],
      workflow_runs: [workflow()],
    };
    const nodes = buildProjectNodes(params(canvas));

    expect(nodes.some((node) => node.id === "workflow-run")).toBe(true);
    expect(
      nodes.filter((node) => node.data.kind === "workflow-item"),
    ).toHaveLength(2);
  });

  it("keeps every Workflow edge endpoint valid for a large plan", () => {
    const selected = requirement();
    const run = workflow(60);
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: selected,
      queued_requirements: [],
      completed_requirements: [],
      workflow_runs: [run],
    };
    const nodes = buildProjectNodes(params(canvas));
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const edge of buildWorkflowRunEdges(selected, run)) {
      expect(nodeIds.has(edge.source), edge.id).toBe(true);
      expect(nodeIds.has(edge.target), edge.id).toBe(true);
    }
  });

  it("still renders requirements and token usage before a plan exists", () => {
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [requirement()],
      completed_requirements: [],
      workflow_runs: [],
    };
    const nodes = buildProjectNodes(params(canvas));
    expect(nodes.some((node) => node.id === "requirements")).toBe(true);
    expect(nodes.some((node) => node.id === "token-usage")).toBe(true);
  });
});
