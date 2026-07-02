import type { Node } from "@xyflow/react";
import type {
  DraftClarificationAnswer,
  FileReference,
  ImageAttachment,
  Project,
  PublicationReadiness,
  ProjectCanvasData,
  Requirement,
  RequirementConversation,
  RequirementExecutionTask,
  ProjectChatEvent,
  ProjectChatResponse,
  TerminalCommandProfile,
  TerminalCommandProfileDraft,
  TerminalSession,
  StartNodeData,
  StreamEvent,
  GitAction,
  GitDiff,
  GitDiffArea,
  GitExpansionPhase,
  GitStatus,
} from "../types/api";
import { buildRequirementDagEdges } from "./edges";
import {
  DAG_NODE_POSITION,
  DAG_NODE_SIZE,
  getTaskGroupChildSize,
  getTaskGroupLayout,
  getTaskLayout,
  getTaskNodeSize,
  TASK_BASE_POSITION,
  type TaskPosition,
} from "./layout";

function withDimensions(nodes: Node<StartNodeData>[]): Node<StartNodeData>[] {
  return nodes.map((node) => {
    if (node.width && node.height) {
      return node;
    }
    const style =
      typeof node.style === "object" && node.style !== null ? node.style : {};
    const styleWidth =
      typeof style.width === "number" ? style.width : undefined;
    const styleHeight =
      typeof style.height === "number" ? style.height : undefined;

    const defaults: Record<
      StartNodeData["kind"],
      { width: number; height: number }
    > = {
      summary: { width: 252, height: 134 },
      "project-github": { width: 137, height: 90 },
      "requirement-list": { width: 290, height: 640 },
      "requirement-chat": { width: 720, height: 760 },
      "project-terminal": { width: 720, height: 44 },
      "project-git": { width: 290, height: 44 },
      "requirement-dag": DAG_NODE_SIZE,
      "requirement-task": { width: 252, height: 134 },
      "token-usage": { width: 290, height: 96 },
    };

    const fallback = defaults[node.data.kind];
    return {
      ...node,
      width: styleWidth ?? node.width ?? fallback.width,
      height: styleHeight ?? node.height ?? fallback.height,
    };
  });
}

export interface BuildProjectNodesParams {
  projectCanvas: ProjectCanvasData | null;
  project: Project | null;
  publicationReadiness: PublicationReadiness | null;
  selectedDagRequirement: Requirement | null;
  selectedDagRequirementId: string | null;
  collapsedTaskGroups: Set<string>;
  requirementActionBusyId: string | null;
  recoveringTaskGroupIds: Set<string>;
  requirementActionError: string | null;
  openSettings: () => void;
  closeDag: () => void;
  selectDagRequirement: (requirement: Requirement) => void;
  planRequirement: (requirement: Requirement) => Promise<void>;
  recoverTaskGroup: (requirementId: string, taskId: string) => Promise<void>;
  toggleTaskGroupCollapsed: (requirementId: string, taskId: string) => void;
}

export interface BuildProjectTerminalNodeParams {
  projectCanvas: ProjectCanvasData | null;
  project: Project | null;
  collapsed: boolean;
  sessions: TerminalSession[];
  activeSessionId: string | null;
  commandProfiles: TerminalCommandProfile[];
  busy: boolean;
  error: string | null;
  terminalDisabled: boolean;
  terminalDisabledReason?: string;
  onToggleCollapsed: () => void;
  onCreateTerminal: (
    command?: string | null,
    title?: string | null,
  ) => Promise<void>;
  onCloseTerminal: (terminalId: string) => Promise<void>;
  onSelectTerminal: (terminalId: string) => void;
  onSaveCommandProfiles: (
    profiles: TerminalCommandProfileDraft[],
  ) => Promise<void>;
}

export interface BuildProjectGitNodeParams {
  projectCanvas: ProjectCanvasData | null;
  project: Project | null;
  phase: GitExpansionPhase;
  status: GitStatus | null;
  diff: GitDiff | null;
  selectedPaths: Set<string>;
  selectedDiff: { path: string; area: GitDiffArea } | null;
  busy: boolean;
  error: string | null;
  lastResult: string | null;
  onToggleExpanded: () => void;
  onRefresh: () => Promise<void>;
  onTogglePath: (path: string) => void;
  onSelectDiff: (path: string, area: GitDiffArea) => Promise<void>;
  onAction: (action: GitAction, result: string) => Promise<boolean>;
}

export interface BuildProjectChatNodeParams {
  projectCanvas: ProjectCanvasData | null;
  project: Project | null;
  requirementConversation: RequirementConversation | null;
  requirementInput: string;
  requirementReferences?: FileReference[];
  requirementImages?: ImageAttachment[];
  requirementBusy: boolean;
  requirementError: string | null;
  requirementStreamEvents: StreamEvent[];
  projectChat: ProjectChatResponse | null;
  projectChatInput: string;
  projectChatReferences?: FileReference[];
  projectChatImages?: ImageAttachment[];
  projectChatBusy: boolean;
  projectChatError: string | null;
  projectChatEvents: ProjectChatEvent[];
  clarificationAnswers: Record<string, DraftClarificationAnswer>;
  dismissedPromptRequirementId: string | null;
  setRequirementInput: (value: string) => void;
  setRequirementReferences?: (references: FileReference[]) => void;
  setRequirementImages?: (images: ImageAttachment[]) => void;
  sendRequirementMessage: () => Promise<void>;
  setProjectChatInput: (value: string) => void;
  setProjectChatReferences?: (references: FileReference[]) => void;
  setProjectChatImages?: (images: ImageAttachment[]) => void;
  sendProjectChatMessage: () => Promise<void>;
  resetProjectChat: () => Promise<void>;
  updateClarificationAnswer: (
    clarification: import("../types/api").RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  submitClarifications: (requirement: Requirement) => Promise<void>;
  confirmRequirement: (requirement: Requirement) => Promise<void>;
  retryRequirementAnalysis?: (requirement: Requirement) => Promise<void>;
  continueEditingRequirement: (requirement: Requirement) => void;
  cancelRequirementAnalysis: (requirementId: string) => Promise<void>;
  abandonRequirement: (requirementId: string) => Promise<void>;
}

export function buildProjectNodes({
  projectCanvas,
  project: currentProject,
  publicationReadiness,
  selectedDagRequirement,
  selectedDagRequirementId,
  collapsedTaskGroups,
  requirementActionBusyId,
  recoveringTaskGroupIds,
  requirementActionError,
  openSettings,
  closeDag,
  selectDagRequirement,
  planRequirement,
  recoverTaskGroup,
  toggleTaskGroupCollapsed,
}: BuildProjectNodesParams): Node<StartNodeData>[] {
  const project = projectCanvas?.project ?? currentProject;
  if (!project) {
    return [];
  }

  const taskLayout = getTaskLayout(
    selectedDagRequirement?.execution_plan?.tasks ?? [],
  );
  const selectedTasks = selectedDagRequirement?.execution_plan?.tasks ?? [];
  const reviewTasksByTarget = new Map<string, RequirementExecutionTask[]>();
  for (const reviewTask of selectedTasks) {
    if (
      (reviewTask.kind !== "review" &&
        reviewTask.kind !== "review_summary" &&
        reviewTask.kind !== "review_sub_agent") ||
      !reviewTask.review_for
    ) {
      continue;
    }
    const reviews = reviewTasksByTarget.get(reviewTask.review_for) ?? [];
    reviews.push(reviewTask);
    reviewTasksByTarget.set(reviewTask.review_for, reviews);
  }
  const implementationTasks = selectedTasks.filter(
    (task) => task.kind === "implementation",
  );
  const standaloneExecutionTasks = selectedTasks.filter(
    (task) => task.kind === "branch_merge" || task.kind === "merge_review",
  );
  const recoveryBusy = (taskId: string) =>
    selectedDagRequirement !== null &&
    recoveringTaskGroupIds.has(`${selectedDagRequirement.id}:${taskId}`);
  const taskPosition = (
    taskId: string,
    fallback: TaskPosition = TASK_BASE_POSITION,
  ): TaskPosition => {
    return taskLayout.get(taskId) ?? fallback;
  };

  return withDimensions([
    {
      id: "project-github",
      type: "startNode",
      position: { x: -197, y: 20 },
      data: {
        kind: "project-github",
        project,
        publicationReadiness: publicationReadiness ?? {
          mode: project.git_url ? "pull_request" : "local",
          ready: !project.git_url,
          summary: "正在读取发布前置检查结果。",
          issues: [],
          notes: [],
        },
      },
    },
    {
      id: "settings",
      type: "startNode",
      position: { x: -350, y: 20 },
      width: 137,
      height: 90,
      data: {
        kind: "summary",
        icon: "model",
        title: "设置",
        description: "基础与模型设置",
        onAction: openSettings,
      },
    },
    {
      id: "completed-requirements",
      type: "startNode",
      position: { x: -350, y: 140 },
      data: {
        kind: "requirement-list",
        title: "已完成需求",
        description: `${projectCanvas?.completed_requirements.length ?? 0} 个`,
        requirements: projectCanvas?.completed_requirements ?? [],
        emptyText: "暂无已完成需求",
        tone: "done",
        selectedRequirementId: selectedDagRequirementId,
        busyRequirementId: requirementActionBusyId,
        onSelectRequirement: selectDagRequirement,
        onPlanRequirement: planRequirement,
      },
    },
    {
      id: "token-usage",
      type: "startNode",
      position: { x: 780, y: 20 },
      width: 290,
      height: 96,
      data: {
        kind: "token-usage",
        usage: projectCanvas?.token_usage ?? null,
      },
    },
    {
      id: "queued-requirements",
      type: "startNode",
      position: { x: 780, y: 140 },
      data: {
        kind: "requirement-list",
        title: "待执行 / 执行中",
        description: `${projectCanvas?.queued_requirements.length ?? 0} 个`,
        requirements: projectCanvas?.queued_requirements ?? [],
        emptyText: "确认需求后会进入这里",
        tone: "pending",
        selectedRequirementId: selectedDagRequirementId,
        busyRequirementId: requirementActionBusyId,
        onSelectRequirement: selectDagRequirement,
        onPlanRequirement: planRequirement,
      },
    },
    ...(selectedDagRequirement
      ? [
          {
            id: "requirement-dag",
            type: "startNode" as const,
            position: DAG_NODE_POSITION,
            data: {
              kind: "requirement-dag" as const,
              requirement: selectedDagRequirement,
              actionError: requirementActionError,
              onClose: closeDag,
            },
          },
          ...implementationTasks.flatMap((task) => {
            const reviews = reviewTasksByTarget.get(task.id) ?? [];
            const summary = reviews.find(
              (review) => review.kind === "review_summary",
            );
            const subAgents = reviews.filter(
              (review) =>
                review.kind === "review_sub_agent" || review.kind === "review",
            );
            const groupId = `requirement-task-group-${task.id}`;
            const collapsed = collapsedTaskGroups.has(
              `${selectedDagRequirement.id}:${task.id}`,
            );
            const groupLayout = getTaskGroupLayout(task, reviews);
            return [
              {
                id: groupId,
                type: "startNode" as const,
                position: taskPosition(task.id),
                style: {
                  width: groupLayout.width,
                  height: collapsed ? 82 : groupLayout.height,
                },
                data: {
                  kind: "requirement-task" as const,
                  nodeRole: "group" as const,
                  requirementId: selectedDagRequirement.id,
                  task,
                  reviews,
                  dependencies: [],
                  collapsed,
                  busy: recoveryBusy(task.id),
                  onToggleCollapsed: toggleTaskGroupCollapsed,
                  onRecoverTaskGroup: recoverTaskGroup,
                },
              },
              ...(collapsed
                ? []
                : [
                    {
                      id: `requirement-task-${task.id}`,
                      type: "startNode" as const,
                      parentId: groupId,
                      extent: "parent" as const,
                      position: groupLayout.positions.get(task.id) ?? {
                        x: 20,
                        y: 96,
                      },
                      style: getTaskGroupChildSize(task),
                      data: {
                        kind: "requirement-task" as const,
                        nodeRole: "code" as const,
                        requirementId: selectedDagRequirement.id,
                        task,
                        reviews,
                        dependencies: [],
                        busy: recoveryBusy(task.id),
                        onRecoverTaskGroup: recoverTaskGroup,
                      },
                    },
                    ...(summary
                      ? [
                          {
                            id: `requirement-task-${summary.id}`,
                            type: "startNode" as const,
                            parentId: groupId,
                            extent: "parent" as const,
                            position: groupLayout.positions.get(summary.id) ?? {
                              x: 20,
                              y: 96,
                            },
                            style: getTaskGroupChildSize(summary),
                            data: {
                              kind: "requirement-task" as const,
                              nodeRole: "review_summary" as const,
                              requirementId: selectedDagRequirement.id,
                              task: summary,
                              reviews: subAgents,
                              dependencies: [],
                              busy: recoveryBusy(task.id),
                              onRecoverTaskGroup: recoverTaskGroup,
                            },
                          },
                        ]
                      : []),
                    ...subAgents.map((review) => ({
                      id: `requirement-task-${review.id}`,
                      type: "startNode" as const,
                      parentId: groupId,
                      extent: "parent" as const,
                      position: groupLayout.positions.get(review.id) ?? {
                        x: 20,
                        y: 96,
                      },
                      style: getTaskGroupChildSize(review),
                      data: {
                        kind: "requirement-task" as const,
                        nodeRole: "review_sub_agent" as const,
                        requirementId: selectedDagRequirement.id,
                        task: review,
                        reviews: [],
                        dependencies: [],
                        busy: recoveryBusy(task.id),
                        onRecoverTaskGroup: recoverTaskGroup,
                      },
                    })),
                  ]),
            ];
          }),
          ...standaloneExecutionTasks.map((task) => {
            const size = getTaskNodeSize(task, selectedTasks);
            return {
              id: `requirement-task-${task.id}`,
              type: "startNode" as const,
              position: taskPosition(task.id),
              style: {
                width: size.width,
                height: size.height,
              },
              data: {
                kind: "requirement-task" as const,
                nodeRole: "external" as const,
                requirementId: selectedDagRequirement.id,
                task,
                reviews: [],
                dependencies: task.depends_on.flatMap((dependencyId) => {
                  const dependency = selectedTasks.find(
                    (candidate) => candidate.id === dependencyId,
                  );
                  return dependency ? [dependency] : [];
                }),
                busy: recoveryBusy(task.id),
                onRecoverTaskGroup: recoverTaskGroup,
              },
            };
          }),
        ]
      : []),
  ]);
}

export function buildProjectChatNode({
  projectCanvas,
  project: currentProject,
  requirementConversation,
  requirementInput,
  requirementReferences = [],
  requirementImages = [],
  requirementBusy,
  requirementError,
  requirementStreamEvents,
  projectChat,
  projectChatInput,
  projectChatReferences = [],
  projectChatImages = [],
  projectChatBusy,
  projectChatError,
  projectChatEvents,
  clarificationAnswers,
  dismissedPromptRequirementId,
  setRequirementInput,
  setRequirementReferences = () => {},
  setRequirementImages = () => {},
  sendRequirementMessage,
  setProjectChatInput,
  setProjectChatReferences = () => {},
  setProjectChatImages = () => {},
  sendProjectChatMessage,
  resetProjectChat,
  updateClarificationAnswer,
  submitClarifications,
  confirmRequirement,
  retryRequirementAnalysis = async () => {},
  continueEditingRequirement,
  cancelRequirementAnalysis,
  abandonRequirement,
}: BuildProjectChatNodeParams): Node<StartNodeData> | null {
  const project = projectCanvas?.project ?? currentProject;
  if (!project) return null;

  const activeRequirementId = projectCanvas?.active_requirement?.id ?? "";

  return withDimensions([
    {
      id: "requirement-chat",
      type: "startNode",
      position: { x: 0, y: 20 },
      data: {
        kind: "requirement-chat",
        project,
        requirement: projectCanvas?.active_requirement ?? null,
        conversation: requirementConversation,
        promptDismissed:
          dismissedPromptRequirementId ===
          (projectCanvas?.active_requirement?.id ?? null),
        input: requirementInput,
        references: requirementReferences,
        images: requirementImages,
        busy: requirementBusy,
        error: requirementError,
        streamEvents: requirementStreamEvents,
        projectChat,
        projectChatInput,
        projectChatReferences,
        projectChatImages,
        projectChatBusy,
        projectChatError,
        projectChatEvents,
        answers: clarificationAnswers,
        onInputChange: setRequirementInput,
        onReferencesChange: setRequirementReferences,
        onImagesChange: setRequirementImages,
        onSend: sendRequirementMessage,
        onProjectChatInputChange: setProjectChatInput,
        onProjectChatReferencesChange: setProjectChatReferences,
        onProjectChatImagesChange: setProjectChatImages,
        onProjectChatSend: sendProjectChatMessage,
        onProjectChatReset: resetProjectChat,
        onAnswerChange: updateClarificationAnswer,
        onSubmitClarifications: submitClarifications,
        onConfirm: confirmRequirement,
        onRetryAnalysis: retryRequirementAnalysis,
        onContinueEditing: continueEditingRequirement,
        onCancel: () => cancelRequirementAnalysis(activeRequirementId),
        onAbandon: () => abandonRequirement(activeRequirementId),
      },
    },
  ])[0];
}

export function buildProjectTerminalNode({
  projectCanvas,
  project: currentProject,
  collapsed,
  sessions,
  activeSessionId,
  commandProfiles,
  busy,
  error,
  terminalDisabled,
  terminalDisabledReason,
  onToggleCollapsed,
  onCreateTerminal,
  onCloseTerminal,
  onSelectTerminal,
  onSaveCommandProfiles,
}: BuildProjectTerminalNodeParams): Node<StartNodeData> | null {
  const project = projectCanvas?.project ?? currentProject;
  if (!project) return null;

  return withDimensions([
    {
      id: "project-terminal",
      type: "startNode",
      position: { x: 0, y: 800 },
      style: {
        width: 720,
        height: collapsed ? 44 : 460,
      },
      data: {
        kind: "project-terminal",
        project,
        collapsed,
        sessions,
        activeSessionId,
        commandProfiles,
        busy,
        error,
        terminalDisabled,
        terminalDisabledReason,
        onToggleCollapsed,
        onCreateTerminal,
        onCloseTerminal,
        onSelectTerminal,
        onSaveCommandProfiles,
      },
    },
  ])[0];
}

export function buildProjectGitNode({
  projectCanvas,
  project: currentProject,
  phase,
  status,
  diff,
  selectedPaths,
  selectedDiff,
  busy,
  error,
  lastResult,
  onToggleExpanded,
  onRefresh,
  onTogglePath,
  onSelectDiff,
  onAction,
}: BuildProjectGitNodeParams): Node<StartNodeData> | null {
  const project = projectCanvas?.project ?? currentProject;
  if (!project) return null;

  return withDimensions([
    {
      id: "project-git",
      type: "startNode",
      position: { x: 780, y: 800 },
      style: {
        width: phase === "expanded" ? 720 : 290,
        height: phase === "collapsed" ? 44 : 460,
      },
      data: {
        kind: "project-git",
        phase,
        status,
        diff,
        selectedPaths,
        selectedDiff,
        busy,
        error,
        lastResult,
        onToggleExpanded,
        onRefresh,
        onTogglePath,
        onSelectDiff,
        onAction,
      },
    },
  ])[0];
}

export function mergeProjectNodes(
  structureNodes: Node<StartNodeData>[],
  ...extraNodes: Array<Node<StartNodeData> | null>
): Node<StartNodeData>[] {
  return [
    ...structureNodes,
    ...extraNodes.filter((node): node is Node<StartNodeData> => Boolean(node)),
  ];
}

export { buildRequirementDagEdges };
