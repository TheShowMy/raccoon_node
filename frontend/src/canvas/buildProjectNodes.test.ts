import { describe, expect, it } from "vitest";
import {
  buildProjectChatNode,
  buildProjectGitNode,
  buildProjectNodes,
  buildProjectSettingsNode,
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
    review_history: [],
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
    project: projectCanvas.project,
    selectedDagRequirement,
    selectedDagRequirementId: selectedDagRequirement?.id ?? null,
    collapsedTaskGroups: new Set(),
    requirementActionBusyId: null,
    recoveringTaskGroupIds: new Set(),
    requirementActionError: null,
    tokenUsageExpanded: false,
    closeDag: () => {},
    selectDagRequirement: () => {},
    planRequirement: async () => {},
    recoverTaskGroup: async () => {},
    toggleTaskGroupCollapsed: () => {},
    onToggleTokenUsageExpanded: () => {},
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
      project: canvas.project,
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
      resetProjectChat: async () => {},
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

  it("builds the Git node below the pending list with phased dimensions", () => {
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [],
      completed_requirements: [],
    };
    const base = {
      projectCanvas: canvas,
      project: canvas.project,
      status: null,
      diff: null,
      selectedPaths: new Set<string>(),
      selectedDiff: null,
      busy: false,
      error: null,
      lastResult: null,
      onToggleExpanded: () => {},
      onRefresh: async () => {},
      onTogglePath: () => {},
      onSelectDiff: async () => {},
      onAction: async () => true,
    };

    const collapsed = buildProjectGitNode({
      ...base,
      phase: "collapsed",
    })!;
    const expanded = buildProjectGitNode({ ...base, phase: "expanded" })!;

    expect(collapsed.position).toEqual({ x: 984, y: 800 });
    expect(collapsed.style).toMatchObject({ width: 360, height: 44 });
    expect(expanded.position).toEqual({ x: 984, y: 800 });
    expect(expanded.style).toMatchObject({ width: 1320, height: 780 });
    expect(expanded.className).toContain("git-flow-node");
  });

  it("builds one settings workbench that expands toward the upper left", () => {
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [],
      completed_requirements: [],
    };
    const base = {
      projectCanvas: canvas,
      project: canvas.project,
      page: "basic" as const,
      basicSettings: null,
      basicError: null,
      savingBasic: false,
      savingTheme: false,
      modelSettings: {
        low: { model_id: null, thinking_level: "low" as const },
        medium: { model_id: null, thinking_level: "medium" as const },
        high: { model_id: null, thinking_level: "high" as const },
      },
      models: [],
      modelRpcStatus: "idle" as const,
      modelError: null,
      savingModels: false,
      terminalDisabled: false,
      terminalAccessRequired: false,
      terminalAccessAuthorized: true,
      terminalAccessBusy: false,
      terminalAccessError: null,
      piLoginSession: null,
      piLoginBusy: false,
      piLoginError: null,
      needsModelOnboarding: true,
      modelDraftComplete: false,
      modelSavedComplete: false,
      onToggleExpanded: () => {},
      onOpenBasic: () => {},
      onOpenModels: () => {},
      onBasicChange: () => {},
      onThemeChange: async () => {},
      onSaveBasic: async () => null,
      onModelChange: () => {},
      onSaveModels: async () => {},
      onReloadModels: async () => {},
      onAuthorizeTerminalAccess: async () => true,
      onStartPiLogin: async () => {},
      onClosePiLogin: async () => {},
    };
    const collapsed = buildProjectSettingsNode({
      ...base,
      expanded: false,
    })!;
    const expanded = buildProjectSettingsNode({ ...base, expanded: true })!;

    expect(collapsed.position).toEqual({ x: 0, y: -44 });
    expect(collapsed.style).toMatchObject({ width: 960, height: 44 });
    expect(expanded.position).toEqual({ x: -180, y: -800 });
    expect(expanded.style).toMatchObject({ width: 1320, height: 780 });
    expect(expanded.data.kind).toBe("project-settings");
    expect(buildProjectNodes(params(canvas, null))).not.toContainEqual(
      expect.objectContaining({ id: "settings" }),
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
    const requirements = nodes.find((node) => node.id === "requirements");
    const dag = nodes.find((node) => node.id === "requirement-dag");

    expect(requirements).toBeDefined();
    expect(dag).toBeDefined();
    expect(dag!.position.x).toBeGreaterThan(
      requirements!.position.x + (requirements!.width ?? 0),
    );
  });

  it("adds token usage above the merged requirements node", () => {
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [],
      completed_requirements: [],
      token_usage: {
        input: 10,
        output: 20,
        cache_read: 30,
        cache_write: 40,
        context_tokens: 50,
        context_window: 100,
        context_percent: 50,
      },
    };

    const nodes = buildProjectNodes(params(canvas, null));
    const token = nodes.find((node) => node.id === "token-usage")!;
    const requirements = nodes.find((node) => node.id === "requirements")!;

    expect(token.position).toEqual({ x: 984, y: -44 });
    expect(token.width).toBe(360);
    expect(requirements.position).toEqual({ x: 984, y: 20 });
    expect(requirements.height).toBe(760);
    expect(token.data).toMatchObject({
      kind: "token-usage",
      usage: canvas.token_usage,
    });
    expect(token.height).toBe(44);
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

  it("only marks the recovering top-level task as busy", () => {
    const selectedRequirement = requirement([
      task("implementation", "implementation", { status: "failed" }),
      task("merge", "branch_merge", { status: "failed" }),
    ]);
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: selectedRequirement,
      queued_requirements: [],
      completed_requirements: [],
    };

    const buildParams = params(canvas, selectedRequirement);
    buildParams.recoveringTaskGroupIds.add("requirement:implementation");
    const taskNodes = buildProjectNodes(buildParams).filter(
      (node) => node.data.kind === "requirement-task",
    );
    const implementationNodes = taskNodes.filter(
      (node) =>
        node.id === "requirement-task-group-implementation" ||
        node.parentId === "requirement-task-group-implementation",
    );
    const mergeNode = taskNodes.find(
      (node) => node.id === "requirement-task-merge",
    )!;

    expect(
      implementationNodes.every(
        (node) => node.data.kind === "requirement-task" && node.data.busy,
      ),
    ).toBe(true);
    expect(mergeNode.data).toMatchObject({ busy: false });
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

  it("injects resolved dependencies into standalone task details", () => {
    const implementation = task("implementation", "implementation", {
      title: "实现登录",
    });
    const merge = task("merge", "branch_merge", {
      depends_on: ["implementation", "missing"],
    });
    const selectedRequirement = requirement([implementation, merge]);
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };

    const mergeNode = buildProjectNodes(
      params(canvas, selectedRequirement),
    ).find((node) => node.id === "requirement-task-merge")!;

    expect(mergeNode.data).toMatchObject({
      kind: "requirement-task",
      dependencies: [{ id: "implementation", title: "实现登录" }],
    });
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

  it("keeps compact review child size stable when failed", () => {
    const implementation = task("implementation");
    const failedReview = task("review-1", "review_sub_agent", {
      status: "failed",
      review_for: "implementation",
    });
    const completedReview = task("review-2", "review_sub_agent", {
      status: "completed",
      review_for: "implementation",
    });
    const selectedRequirement = requirement([
      implementation,
      failedReview,
      completedReview,
    ]);
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [selectedRequirement],
      completed_requirements: [],
    };

    const nodes = buildProjectNodes(params(canvas, selectedRequirement));
    const failed = nodes.find(
      (node) => node.id === "requirement-task-review-1",
    )!;
    const completed = nodes.find(
      (node) => node.id === "requirement-task-review-2",
    )!;

    expect({ width: failed.width, height: failed.height }).toEqual({
      width: 140,
      height: 52,
    });
    expect({ width: completed.width, height: completed.height }).toEqual({
      width: 140,
      height: 52,
    });
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
