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
import { getTaskLayout, getTaskNodeHeight } from "./layout";

function withDimensions<T extends Record<string, unknown>>(
  nodes: Node<T>[],
): Node<T>[] {
  return nodes.map((node) => {
    if (node.width && node.height) {
      return node;
    }
    const style =
      typeof node.style === "object" && node.style !== null ? node.style : {};
    const width =
      typeof style.width === "number" ? style.width : (node.width ?? 252);
    const height =
      typeof style.height === "number" ? style.height : (node.height ?? 134);
    return { ...node, width, height };
  });
}

export interface BuildProjectNodesParams {
  projectCanvas: ProjectCanvasData | null;
  selectedProjectId: string | null;
  startProjects: Project[];
  selectedDagRequirement: Requirement | null;
  selectedDagRequirementId: string | null;
  observedRequirementId: string | null;
  collapsedTaskGroups: Set<string>;
  requirementActionBusyId: string | null;
  requirementConversation: RequirementConversation | null;
  requirementInput: string;
  requirementBusy: boolean;
  requirementError: string | null;
  requirementStreamEvents: StreamEvent[];
  clarificationAnswers: Record<string, DraftClarificationAnswer>;
  dismissedPromptRequirementId: string | null;
  backToStartCanvas: () => void;
  closeDag: () => void;
  selectDagRequirement: (requirement: Requirement) => void;
  planRequirement: (requirement: Requirement) => Promise<void>;
  startExecution: (requirement: Requirement) => Promise<void>;
  retryFailedNode: (requirementId: string, taskId: string) => Promise<void>;
  retryFromNode: (requirementId: string, taskId: string) => Promise<void>;
  rerunReview: (requirementId: string, taskId: string) => Promise<void>;
  setRequirementInput: (value: string) => void;
  sendRequirementMessage: () => Promise<void>;
  updateClarificationAnswer: (
    clarification: import("../types/api").RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  submitClarifications: (requirement: Requirement) => Promise<void>;
  confirmRequirement: (requirement: Requirement) => Promise<void>;
  continueEditingRequirement: (requirement: Requirement) => void;
  toggleTaskGroupCollapsed: (requirementId: string, taskId: string) => void;
}

export function buildProjectNodes({
  projectCanvas,
  selectedProjectId,
  startProjects,
  selectedDagRequirement,
  selectedDagRequirementId,
  observedRequirementId,
  collapsedTaskGroups,
  requirementActionBusyId,
  requirementConversation,
  requirementInput,
  requirementBusy,
  requirementError,
  requirementStreamEvents,
  clarificationAnswers,
  dismissedPromptRequirementId,
  backToStartCanvas,
  closeDag,
  selectDagRequirement,
  planRequirement,
  startExecution,
  retryFailedNode,
  retryFromNode,
  rerunReview,
  setRequirementInput,
  sendRequirementMessage,
  updateClarificationAnswer,
  submitClarifications,
  confirmRequirement,
  continueEditingRequirement,
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
  const dagFocused = Boolean(selectedDagRequirement);
  const projectControlX = dagFocused ? -420 : -328;

  return withDimensions<StartNodeData>([
    {
      id: "project-github",
      type: "startNode",
      position: { x: projectControlX, y: -84 },
      data: {
        kind: "project-github",
        project,
      },
    },
    {
      id: "project-back",
      type: "startNode",
      position: { x: projectControlX, y: 20 },
      data: {
        kind: "project-back",
        project,
        onBack: backToStartCanvas,
      },
    },
    {
      id: "completed-requirements",
      type: "startNode",
      position: dagFocused ? { x: -420, y: 140 } : { x: -350, y: 140 },
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
    ...(!dagFocused
      ? [
          {
            id: "requirement-chat",
            type: "startNode" as const,
            position: { x: 0, y: 20 },
            data: {
              kind: "requirement-chat" as const,
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
            },
          },
        ]
      : []),
    {
      id: "queued-requirements",
      type: "startNode",
      position: dagFocused ? { x: -100, y: 140 } : { x: 780, y: 140 },
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
            position: { x: 280, y: 80 },
            data: {
              kind: "requirement-dag" as const,
              requirement: selectedDagRequirement,
              busy: requirementActionBusyId === selectedDagRequirement.id,
              onStartExecution: startExecution,
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
            return [
              {
                id: groupId,
                type: "startNode" as const,
                position: taskLayout.get(task.id) ?? { x: 720, y: 60 },
                style: {
                  width: 590,
                  height: collapsed ? 82 : getTaskNodeHeight(task),
                },
                data: {
                  kind: "requirement-task" as const,
                  nodeRole: "group" as const,
                  requirementId: selectedDagRequirement.id,
                  task,
                  reviews,
                  collapsed,
                  streamEvents:
                    selectedDagRequirement.id === observedRequirementId
                      ? requirementStreamEvents
                      : [],
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
                      position: { x: 20, y: 108 },
                      style: {
                        width: 142,
                        height: 142,
                      },
                      data: {
                        kind: "requirement-task" as const,
                        nodeRole: "code" as const,
                        requirementId: selectedDagRequirement.id,
                        task,
                        reviews,
                        streamEvents:
                          selectedDagRequirement.id === observedRequirementId
                            ? requirementStreamEvents
                            : [],
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
                            position: { x: 198, y: 108 },
                            style: {
                              width: 142,
                              height: 142,
                            },
                            data: {
                              kind: "requirement-task" as const,
                              nodeRole: "review_summary" as const,
                              requirementId: selectedDagRequirement.id,
                              task: summary,
                              reviews: subAgents,
                              streamEvents:
                                selectedDagRequirement.id ===
                                observedRequirementId
                                  ? requirementStreamEvents
                                  : [],
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
                    ...subAgents.map((review, index) => ({
                      id: `requirement-task-${review.id}`,
                      type: "startNode" as const,
                      parentId: groupId,
                      extent: "parent" as const,
                      position: { x: 400, y: 82 + index * 66 },
                      style: {
                        width: 140,
                        height: 52,
                      },
                      data: {
                        kind: "requirement-task" as const,
                        nodeRole: "review_sub_agent" as const,
                        requirementId: selectedDagRequirement.id,
                        task: review,
                        reviews: [],
                        streamEvents:
                          selectedDagRequirement.id === observedRequirementId
                            ? requirementStreamEvents
                            : [],
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
          ...standaloneExecutionTasks.map((task) => ({
            id: `requirement-task-${task.id}`,
            type: "startNode" as const,
            position: taskLayout.get(task.id) ?? { x: 720, y: 60 },
            style: {
              width: 380,
              height: getTaskNodeHeight(task),
            },
            data: {
              kind: "requirement-task" as const,
              nodeRole: "external" as const,
              requirementId: selectedDagRequirement.id,
              task,
              reviews: [],
              streamEvents:
                selectedDagRequirement.id === observedRequirementId
                  ? requirementStreamEvents
                  : [],
              busy: requirementActionBusyId === selectedDagRequirement.id,
              onRetryFailedNode: retryFailedNode,
              onRetryFromNode: retryFromNode,
              onRerunReview: rerunReview,
            },
          })),
        ]
      : []),
  ]);
}

export { buildRequirementDagEdges };
