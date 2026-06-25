import type { Node } from "@xyflow/react";
import type {
  DraftClarificationAnswer,
  Project,
  ProjectCanvasData,
  Requirement,
  RequirementConversation,
  RequirementExecutionTask,
  StartNodeData,
  StreamEvent,
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
      create: { width: 252, height: 134 },
      projects: { width: 420, height: 220 },
      "project-item": { width: 348, height: 86 },
      "delete-confirm": { width: 252, height: 134 },
      "model-config": { width: 252, height: 360 },
      "style-settings": { width: 252, height: 134 },
      summary: { width: 252, height: 134 },
      "project-back": { width: 252, height: 90 },
      "project-github": { width: 252, height: 90 },
      "requirement-list": { width: 290, height: 640 },
      "requirement-chat": { width: 720, height: 760 },
      "requirement-dag": DAG_NODE_SIZE,
      "requirement-task": { width: 252, height: 134 },
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
  selectedProjectId: string | null;
  startProjects: Project[];
  selectedDagRequirement: Requirement | null;
  selectedDagRequirementId: string | null;
  collapsedTaskGroups: Set<string>;
  requirementActionBusyId: string | null;
  requirementActionError: string | null;
  backToStartCanvas: () => void;
  closeDag: () => void;
  selectDagRequirement: (requirement: Requirement) => void;
  planRequirement: (requirement: Requirement) => Promise<void>;
  retryFailedNode: (requirementId: string, taskId: string) => Promise<void>;
  retryFromNode: (requirementId: string, taskId: string) => Promise<void>;
  rerunReview: (requirementId: string, taskId: string) => Promise<void>;
  toggleTaskGroupCollapsed: (requirementId: string, taskId: string) => void;
}

export interface BuildProjectChatNodeParams {
  projectCanvas: ProjectCanvasData | null;
  selectedProjectId: string | null;
  startProjects: Project[];
  requirementConversation: RequirementConversation | null;
  requirementInput: string;
  requirementBusy: boolean;
  requirementError: string | null;
  requirementStreamEvents: StreamEvent[];
  clarificationAnswers: Record<string, DraftClarificationAnswer>;
  dismissedPromptRequirementId: string | null;
  setRequirementInput: (value: string) => void;
  sendRequirementMessage: () => Promise<void>;
  updateClarificationAnswer: (
    clarification: import("../types/api").RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  submitClarifications: (requirement: Requirement) => Promise<void>;
  confirmRequirement: (requirement: Requirement) => Promise<void>;
  continueEditingRequirement: (requirement: Requirement) => void;
  cancelRequirementAnalysis: (requirementId: string) => Promise<void>;
}

export function buildProjectNodes({
  projectCanvas,
  selectedProjectId,
  startProjects,
  selectedDagRequirement,
  selectedDagRequirementId,
  collapsedTaskGroups,
  requirementActionBusyId,
  requirementActionError,
  backToStartCanvas,
  closeDag,
  selectDagRequirement,
  planRequirement,
  retryFailedNode,
  retryFromNode,
  rerunReview,
  toggleTaskGroupCollapsed,
}: BuildProjectNodesParams): Node<StartNodeData>[] {
  const fallbackProject = selectedProjectId
    ? startProjects.find((project) => project.id === selectedProjectId)
    : null;
  const project = projectCanvas?.project ?? fallbackProject;
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
      position: { x: -328, y: -84 },
      data: {
        kind: "project-github",
        project,
      },
    },
    {
      id: "project-back",
      type: "startNode",
      position: { x: -328, y: 20 },
      data: {
        kind: "project-back",
        project,
        onBack: backToStartCanvas,
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
                  collapsed,
                  busy: requirementActionBusyId === selectedDagRequirement.id,
                  onToggleCollapsed: toggleTaskGroupCollapsed,
                  onRetryFailedNode: retryFailedNode,
                  onRetryFromNode: retryFromNode,
                  onRerunReview: rerunReview,
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
                        busy:
                          requirementActionBusyId === selectedDagRequirement.id,
                        onRetryFailedNode: retryFailedNode,
                        onRetryFromNode: retryFromNode,
                        onRerunReview: rerunReview,
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
                              busy:
                                requirementActionBusyId ===
                                selectedDagRequirement.id,
                              onRetryFailedNode: retryFailedNode,
                              onRetryFromNode: retryFromNode,
                              onRerunReview: rerunReview,
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
                        busy:
                          requirementActionBusyId === selectedDagRequirement.id,
                        onRetryFailedNode: retryFailedNode,
                        onRetryFromNode: retryFromNode,
                        onRerunReview: rerunReview,
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
                busy: requirementActionBusyId === selectedDagRequirement.id,
                onRetryFailedNode: retryFailedNode,
                onRetryFromNode: retryFromNode,
                onRerunReview: rerunReview,
              },
            };
          }),
        ]
      : []),
  ]);
}

export function buildProjectChatNode({
  projectCanvas,
  selectedProjectId,
  startProjects,
  requirementConversation,
  requirementInput,
  requirementBusy,
  requirementError,
  requirementStreamEvents,
  clarificationAnswers,
  dismissedPromptRequirementId,
  setRequirementInput,
  sendRequirementMessage,
  updateClarificationAnswer,
  submitClarifications,
  confirmRequirement,
  continueEditingRequirement,
  cancelRequirementAnalysis,
}: BuildProjectChatNodeParams): Node<StartNodeData> | null {
  const fallbackProject = selectedProjectId
    ? startProjects.find((project) => project.id === selectedProjectId)
    : null;
  const project = projectCanvas?.project ?? fallbackProject;
  if (!project) return null;

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
        busy: requirementBusy,
        error: requirementError,
        streamEvents: requirementStreamEvents,
        answers: clarificationAnswers,
        onInputChange: setRequirementInput,
        onSend: sendRequirementMessage,
        onAnswerChange: updateClarificationAnswer,
        onSubmitClarifications: submitClarifications,
        onConfirm: confirmRequirement,
        onContinueEditing: continueEditingRequirement,
        onCancel: () =>
          cancelRequirementAnalysis(
            projectCanvas?.active_requirement?.id ?? "",
          ),
      },
    },
  ])[0];
}

export function mergeProjectNodes(
  structureNodes: Node<StartNodeData>[],
  chatNode: Node<StartNodeData> | null,
): Node<StartNodeData>[] {
  return chatNode ? [...structureNodes, chatNode] : structureNodes;
}

export { buildRequirementDagEdges };
