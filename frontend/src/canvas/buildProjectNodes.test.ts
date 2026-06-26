import { describe, expect, it } from "vitest";
import {
  buildProjectChatNode,
  buildProjectNodes,
  buildRequirementDagEdges,
  mergeProjectNodes,
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

function task(
  id: string,
  kind: RequirementExecutionTask["kind"] = "implementation",
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

function requirement(
  tasks: RequirementExecutionTask[] = [task("implementation")],
): Requirement {
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
      tasks,
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
    collapsedTaskGroups: new Set(),
    requirementActionBusyId: null,
    requirementActionError: null,
    backToStartCanvas: () => {},
    closeDag: () => {},
    selectDagRequirement: () => {},
    planRequirement: async () => {},
    retryFailedNode: async () => {},
    retryFromNode: async () => {},
    rerunReview: async () => {},
    toggleTaskGroupCollapsed: () => {},
  };
}

describe("buildProjectNodes", () => {
  it("replaces only the chat node when high-frequency chat state changes", () => {
    const selectedRequirement = requirement();
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: selectedRequirement,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };
    const structure = buildProjectNodes(params(canvas, selectedRequirement));
    const chatParams = {
      projectCanvas: canvas,
      selectedProjectId: canvas.project.id,
      startProjects: [canvas.project],
      requirementConversation: null,
      requirementInput: "",
      requirementBusy: false,
      requirementError: null,
      requirementStreamEvents: [],
      projectChat: null,
      projectChatInput: "",
      projectChatBusy: false,
      projectChatError: null,
      projectChatEvents: [],
      clarificationAnswers: {},
      dismissedPromptRequirementId: null,
      setRequirementInput: () => {},
      sendRequirementMessage: async () => {},
      setProjectChatInput: () => {},
      sendProjectChatMessage: async () => {},
      updateClarificationAnswer: () => {},
      submitClarifications: async () => {},
      confirmRequirement: async () => {},
      continueEditingRequirement: () => {},
      cancelRequirementAnalysis: async () => {},
      abandonRequirement: async () => {},
    };
    const first = mergeProjectNodes(
      structure,
      buildProjectChatNode(chatParams),
    );
    const second = mergeProjectNodes(
      structure,
      buildProjectChatNode({ ...chatParams, requirementInput: "新输入" }),
    );

    for (const node of structure) {
      expect(second.find((candidate) => candidate.id === node.id)).toBe(node);
    }
    expect(second.find((node) => node.id === "requirement-chat")).not.toBe(
      first.find((node) => node.id === "requirement-chat"),
    );
  });

  it("places compact project actions side by side with back on the left", () => {
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [],
      completed_requirements: [],
    };

    const nodes = buildProjectNodes(params(canvas, null));
    const back = nodes.find((node) => node.id === "project-back")!;
    const github = nodes.find((node) => node.id === "project-github")!;
    const completed = nodes.find(
      (node) => node.id === "completed-requirements",
    )!;

    expect(back.position).toEqual({ x: -350, y: 20 });
    expect(github.position).toEqual({ x: -197, y: 20 });
    expect(back.width).toBe(137);
    expect(github.width).toBe(137);
    expect(back.height).toBe(90);
    expect(github.height).toBe(90);
    expect((github.position.x ?? 0) + (github.width ?? 0)).toBe(
      (completed.position.x ?? 0) + (completed.width ?? 0),
    );
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

  it("passes recovery errors to the selected DAG node", () => {
    const selectedRequirement = requirement();
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };
    const buildParams = params(canvas, selectedRequirement);
    buildParams.requirementActionError = "恢复失败";

    const dag = buildProjectNodes(buildParams).find(
      (node) => node.id === "requirement-dag",
    )!;

    expect(dag.data).toMatchObject({
      kind: "requirement-dag",
      actionError: "恢复失败",
    });
  });

  it("keeps the first task 130px to the right of the DAG", () => {
    const selectedRequirement = requirement();
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };

    const nodes = buildProjectNodes(params(canvas, selectedRequirement));
    const dag = nodes.find((node) => node.id === "requirement-dag")!;
    const firstTask = nodes.find(
      (node) => node.id === "requirement-task-group-implementation",
    )!;

    expect(firstTask.position.x - (dag.position.x + (dag.width ?? 0))).toBe(
      130,
    );
  });

  it("uses dependency layout for task children and keeps them in the group", () => {
    const implementation = task("implementation");
    const subAgents = Array.from({ length: 5 }, (_, index) =>
      task(`review-${index}`, "review_sub_agent", {
        depends_on: ["implementation"],
        review_for: "implementation",
      }),
    );
    const summary = task("summary", "review_summary", {
      depends_on: subAgents.map((review) => review.id),
      review_for: "implementation",
    });
    const selectedRequirement = requirement([
      implementation,
      ...subAgents,
      summary,
    ]);
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };

    const nodes = buildProjectNodes(params(canvas, selectedRequirement));
    const group = nodes.find(
      (node) => node.id === "requirement-task-group-implementation",
    )!;
    const code = nodes.find(
      (node) => node.id === "requirement-task-implementation",
    )!;
    const firstReview = nodes.find(
      (node) => node.id === "requirement-task-review-0",
    )!;
    const summaryNode = nodes.find(
      (node) => node.id === "requirement-task-summary",
    )!;

    expect(code.position.x).toBeLessThan(summaryNode.position.x);
    expect(summaryNode.position.x).toBeLessThan(firstReview.position.x);
    expect({ width: code.width, height: code.height }).toEqual({
      width: 142,
      height: 142,
    });
    expect(group.height).toBeGreaterThan(300);
    for (const child of nodes.filter((node) => node.parentId === group.id)) {
      expect(child.position.x + (child.width ?? 0)).toBeLessThanOrEqual(
        group.width ?? 0,
      );
      expect(child.position.y + (child.height ?? 0)).toBeLessThanOrEqual(
        group.height ?? 0,
      );
    }
  });

  it("keeps collapsed groups at 82px without child nodes", () => {
    const selectedRequirement = requirement();
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };
    const collapsedParams = params(canvas, selectedRequirement);
    collapsedParams.collapsedTaskGroups = new Set([
      "requirement:implementation",
    ]);

    const nodes = buildProjectNodes(collapsedParams);
    const group = nodes.find(
      (node) => node.id === "requirement-task-group-implementation",
    )!;

    expect(group.height).toBe(82);
    expect(nodes.some((node) => node.parentId === group.id)).toBe(false);
  });

  it("keeps every edge endpoint valid with more than 50 DAG nodes", () => {
    const tasks = Array.from({ length: 11 }, (_, index) => {
      const implementation = task(`implementation-${index}`);
      const reviews = Array.from({ length: 3 }, (_, reviewIndex) =>
        task(`review-${index}-${reviewIndex}`, "review_sub_agent", {
          depends_on: [implementation.id],
          review_for: implementation.id,
        }),
      );
      const summary = task(`summary-${index}`, "review_summary", {
        depends_on: reviews.map((review) => review.id),
        review_for: implementation.id,
      });
      return [implementation, ...reviews, summary];
    }).flat();
    const selectedRequirement = requirement(tasks);
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };
    const nodes = buildProjectNodes(params(canvas, selectedRequirement));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = buildRequirementDagEdges(selectedRequirement, new Set());

    expect(nodes.length).toBeGreaterThan(50);
    for (const edge of edges) {
      expect(nodeIds.has(edge.source), edge.id).toBe(true);
      expect(nodeIds.has(edge.target), edge.id).toBe(true);
    }
  });
});
