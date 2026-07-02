import { describe, expect, it } from "vitest";
import {
  buildProjectChatNode,
  buildProjectGitNode,
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
    publicationReadiness: {
      mode: "local",
      ready: true,
      summary: "本地合并",
      issues: [],
      notes: [],
    },
    selectedDagRequirement,
    selectedDagRequirementId: selectedDagRequirement?.id ?? null,
    collapsedTaskGroups: new Set(),
    requirementActionBusyId: null,
    recoveringTaskGroupIds: new Set(),
    requirementActionError: null,
    settingsView: "closed",
    basicSettings: null,
    basicSettingsError: null,
    savingBasicSettings: false,
    draftModelSettings: {
      low: { model_id: null, thinking_level: "low" },
      medium: { model_id: null, thinking_level: "medium" },
      high: { model_id: null, thinking_level: "high" },
    },
    models: [],
    modelRpcStatus: "idle",
    modelError: null,
    savingModels: false,
    openSettings: () => {},
    openBasicSettings: () => {},
    openModelSettings: () => {},
    closeSettingsDetail: () => {},
    closeSettingsList: () => {},
    updateBasicSettings: () => {},
    saveBasicSettings: async () => {},
    updateModelTier: () => {},
    saveModelSettings: async () => {},
    closeDag: () => {},
    selectDagRequirement: () => {},
    planRequirement: async () => {},
    recoverTaskGroup: async () => {},
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

  it("places GitHub and model actions at the top of the project canvas", () => {
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [],
      completed_requirements: [],
    };

    const nodes = buildProjectNodes(params(canvas, null));
    const github = nodes.find((node) => node.id === "project-github")!;
    const model = nodes.find((node) => node.id === "settings")!;
    const completed = nodes.find(
      (node) => node.id === "completed-requirements",
    )!;

    expect(github.position).toEqual({ x: -197, y: 20 });
    expect(model.position).toEqual({ x: -350, y: 20 });
    expect(github.width).toBe(137);
    expect(github.height).toBe(90);
    expect(model.width).toBe(137);
    expect(model.height).toBe(90);
    expect(model.data.kind).toBe("summary");
    expect(completed.position).toEqual({ x: -350, y: 140 });
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
    const vertical = buildProjectGitNode({ ...base, phase: "vertical" })!;
    const expanded = buildProjectGitNode({ ...base, phase: "expanded" })!;

    expect(collapsed.position).toEqual({ x: 780, y: 800 });
    expect(collapsed.style).toMatchObject({ width: 290, height: 44 });
    expect(vertical.style).toMatchObject({ width: 290, height: 460 });
    expect(expanded.style).toMatchObject({ width: 720, height: 460 });
  });

  it("opens model configuration from the project canvas", () => {
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [],
      completed_requirements: [],
    };
    const buildParams = params(canvas, null);
    buildParams.settingsView = "models";

    const nodes = buildProjectNodes(buildParams);
    const settingsList = nodes.find((node) => node.id === "settings-list");
    const modelConfig = nodes.find((node) => node.id === "model-config");

    expect(settingsList?.data.kind).toBe("settings-list");
    expect(modelConfig?.data.kind).toBe("model-config");
  });

  it("keeps the settings list open beside basic settings", () => {
    const canvas: ProjectCanvasData = {
      project: project(),
      active_requirement: null,
      queued_requirements: [],
      completed_requirements: [],
    };
    const buildParams = params(canvas, null);
    buildParams.settingsView = "basic";
    buildParams.basicSettings = {
      theme: "dark",
      host: "127.0.0.1",
      port: 3000,
      port_overridden: false,
      commit_mode: "local",
    };

    const nodes = buildProjectNodes(buildParams);

    expect(nodes.find((node) => node.id === "settings-list")).toBeDefined();
    expect(nodes.find((node) => node.id === "basic-settings")?.data.kind).toBe(
      "basic-settings",
    );
    expect(nodes.find((node) => node.id === "model-config")).toBeUndefined();
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

  it("adds token usage above queued requirements", () => {
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

    expect(token.position).toEqual({ x: 780, y: 20 });
    expect(token.data).toMatchObject({
      kind: "token-usage",
      usage: canvas.token_usage,
    });
    expect(token.height).toBe(96);
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
