import { describe, expect, it } from "vitest";
import {
  buildProjectNodes,
  type BuildProjectNodesParams,
} from "./buildProjectNodes";
import type {
  Project,
  ProjectCanvasData,
  Requirement,
  RequirementExecutionTask,
} from "../types/api";

const now = new Date(0).toISOString();

function project(): Project {
  return {
    id: "project",
    name: "Project",
    git_url: "https://example.com/repo.git",
    local_path: "/tmp/repo",
    created_at: now,
    updated_at: now,
  };
}

function task(id: string): RequirementExecutionTask {
  return {
    id,
    title: id,
    description: id,
    depends_on: [],
    kind: "implementation",
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

function requirement(): Requirement {
  return {
    id: "requirement",
    project_id: "project",
    title: "Requirement",
    original_message: "Requirement",
    status: "queued",
    messages: [],
    clarification_round: 0,
    clarifications: [],
    draft: null,
    execution_plan: {
      summary: "Plan",
      tasks: [task("implementation")],
    },
    pi_session_file: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
}

function params(
  projectCanvas: ProjectCanvasData,
  selectedDagRequirement: Requirement | null,
): BuildProjectNodesParams {
  return {
    projectCanvas,
    selectedProjectId: projectCanvas.project.id,
    startProjects: [projectCanvas.project],
    selectedDagRequirement,
    selectedDagRequirementId: selectedDagRequirement?.id ?? null,
    observedRequirementId: null,
    collapsedTaskGroups: new Set(),
    requirementActionBusyId: null,
    requirementConversation: null,
    requirementInput: "",
    requirementBusy: false,
    requirementError: null,
    requirementStreamEvents: [],
    clarificationAnswers: {},
    dismissedPromptRequirementId: null,
    backToStartCanvas: () => {},
    closeDag: () => {},
    selectDagRequirement: () => {},
    planRequirement: async () => {},
    startExecution: async () => {},
    retryFailedNode: async () => {},
    retryFromNode: async () => {},
    rerunReview: async () => {},
    setRequirementInput: () => {},
    sendRequirementMessage: async () => {},
    updateClarificationAnswer: () => {},
    submitClarifications: async () => {},
    confirmRequirement: async () => {},
    continueEditingRequirement: () => {},
    toggleTaskGroupCollapsed: () => {},
  };
}

describe("buildProjectNodes", () => {
  it("keeps the requirement chat visible while a DAG is selected", () => {
    const selectedRequirement = requirement();
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: selectedRequirement,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };

    const nodes = buildProjectNodes(params(canvas, selectedRequirement));

    expect(nodes.some((node) => node.id === "requirement-chat")).toBe(true);
  });

  it("places the DAG entry to the right of the project requirement list", () => {
    const selectedRequirement = requirement();
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };

    const nodes = buildProjectNodes(params(canvas, selectedRequirement));
    const queuedList = nodes.find((node) => node.id === "queued-requirements");
    const dag = nodes.find((node) => node.id === "requirement-dag");

    expect(queuedList).toBeDefined();
    expect(dag).toBeDefined();
    expect(dag!.position.x).toBeGreaterThan(
      queuedList!.position.x + (queuedList!.width ?? 0),
    );
  });
});
