import type { Node } from "@xyflow/react";
import type {
  ChatSubmission,
  DraftClarificationAnswer,
  FileReference,
  ImageAttachment,
  Project,
  ProjectCanvasData,
  Requirement,
  RequirementConversation,
  RequirementNodeData,
  ConversationEvent,
  ProjectChatResponse,
  StartNodeData,
  StreamEvent,
} from "../types/api";
import {
  REQUIREMENT_CHAT_NODE_SIZE,
  REQUIREMENT_LIST_NODE_SIZE,
  WORKFLOW_RUN_NODE_SIZE,
  mainNodePositions,
  workflowItemPositions,
} from "./layout";

function withDimensions<T extends StartNodeData>(nodes: Node<T>[]): Node<T>[] {
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
      "requirement-list": REQUIREMENT_LIST_NODE_SIZE,
      "requirement-chat": REQUIREMENT_CHAT_NODE_SIZE,
      "workflow-run": WORKFLOW_RUN_NODE_SIZE,
      "workflow-item": { width: 340, height: 220 },
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
  selectedWorkflowRequirement: Requirement | null;
  selectedWorkflowRequirementId: string | null;
  requirementActionBusyId: string | null;
  requirementActionError: string | null;
  closeWorkflow: () => void;
  selectWorkflowRequirement: (requirement: Requirement) => void;
  planRequirement: (requirement: Requirement) => Promise<void>;
}

export interface BuildProjectChatNodeParams {
  projectCanvas: ProjectCanvasData | null;
  project: Project | null;
  requirementConversation: RequirementConversation | null;
  requirementBusy: boolean;
  requirementOpeningId: string | null;
  requirementError: string | null;
  requirementStreamEvents: StreamEvent[];
  projectChat: ProjectChatResponse | null;
  projectChatBusy: boolean;
  projectChatError: string | null;
  projectChatEvents: ConversationEvent[];
  dismissedPromptRequirementId: string | null;
  startRequirement: (
    description: string,
    attachments: {
      references: FileReference[];
      images: ImageAttachment[];
    },
  ) => Promise<boolean>;
  sendRequirementMessage: (payload: ChatSubmission) => Promise<boolean>;
  sendProjectChatMessage: (payload: ChatSubmission) => Promise<boolean>;
  abortProjectChat?: () => Promise<void>;
  resetProjectChat: () => Promise<boolean>;
  openRequirement?: (requirementId: string) => void;
  submitClarifications: (
    requirement: Requirement,
    answers: Record<string, DraftClarificationAnswer>,
  ) => Promise<boolean>;
  confirmRequirement: (requirement: Requirement) => Promise<void>;
  retryRequirementAnalysis?: (requirement: Requirement) => Promise<void>;
  continueEditingRequirement: (requirement: Requirement) => void;
  cancelRequirementAnalysis: (requirementId: string) => Promise<void>;
  abandonRequirement: (requirementId: string) => Promise<void>;
}

export function buildProjectNodes({
  projectCanvas,
  project: currentProject,
  selectedWorkflowRequirement,
  selectedWorkflowRequirementId,
  requirementActionBusyId,
  requirementActionError,
  closeWorkflow,
  selectWorkflowRequirement,
  planRequirement,
}: BuildProjectNodesParams): Node<RequirementNodeData>[] {
  const project = projectCanvas?.project ?? currentProject;
  if (!project) {
    return [];
  }

  const selectedWorkflow = selectedWorkflowRequirement
    ? ((projectCanvas?.workflow_runs ?? []).find(
        (workflow) =>
          workflow.run.requirement_id === selectedWorkflowRequirement.id,
      ) ?? null)
    : null;
  const selectedWorkflowItemPositions = selectedWorkflow
    ? workflowItemPositions(selectedWorkflow)
    : new Map<string, { x: number; y: number }>();

  const positions = mainNodePositions();

  return withDimensions<RequirementNodeData>([
    {
      id: "requirements",
      type: "startNode",
      position: positions["requirement-list"],
      style: { width: 360, height: 760 },
      data: {
        kind: "requirement-list",
        pendingRequirements: projectCanvas?.queued_requirements ?? [],
        completedRequirements: projectCanvas?.completed_requirements ?? [],
        workflowRequirementIds: new Set(
          (projectCanvas?.workflow_runs ?? []).map(
            (workflow) => workflow.run.requirement_id,
          ),
        ),
        selectedRequirementId: selectedWorkflowRequirementId,
        busyRequirementId: requirementActionBusyId,
        onSelectRequirement: selectWorkflowRequirement,
        onPlanRequirement: planRequirement,
      },
    },
    ...(selectedWorkflowRequirement
      ? [
          {
            id: "workflow-run",
            type: "startNode" as const,
            position: positions["workflow-run"],
            style: {
              width: WORKFLOW_RUN_NODE_SIZE.width,
              height: WORKFLOW_RUN_NODE_SIZE.height,
            },
            data: {
              kind: "workflow-run" as const,
              requirement: selectedWorkflowRequirement,
              workflowRun: selectedWorkflow,
              actionError: requirementActionError,
              onClose: closeWorkflow,
            },
          },
          ...(selectedWorkflow
            ? selectedWorkflow.work_items.map((item) => ({
                id: `workflow-item-${item.id}`,
                type: "startNode" as const,
                position:
                  selectedWorkflowItemPositions.get(item.id) ??
                  positions["workflow-run"],
                style: { width: 340, height: 220 },
                data: {
                  kind: "workflow-item" as const,
                  workflow: selectedWorkflow,
                  item,
                },
              }))
            : []),
        ]
      : []),
  ]);
}

export function buildProjectChatNode({
  projectCanvas,
  project: currentProject,
  requirementConversation,
  requirementBusy,
  requirementOpeningId,
  requirementError,
  requirementStreamEvents,
  projectChat,
  projectChatBusy,
  projectChatError,
  projectChatEvents,
  dismissedPromptRequirementId,
  startRequirement,
  sendRequirementMessage,
  sendProjectChatMessage,
  abortProjectChat = async () => {},
  resetProjectChat,
  openRequirement = () => {},
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

  const positions = mainNodePositions();

  return withDimensions<StartNodeData>([
    {
      id: "requirement-chat",
      type: "startNode",
      position: positions["requirement-chat"],
      data: {
        kind: "requirement-chat",
        project,
        requirement: projectCanvas?.active_requirement ?? null,
        conversation: requirementConversation,
        promptDismissed:
          dismissedPromptRequirementId ===
          (projectCanvas?.active_requirement?.id ?? null),
        busy: requirementBusy,
        requirementOpeningId,
        error: requirementError,
        streamEvents: requirementStreamEvents,
        projectChat,
        projectChatBusy,
        projectChatError,
        projectChatEvents,
        onSend: sendRequirementMessage,
        onStartRequirement: startRequirement,
        onProjectChatSend: sendProjectChatMessage,
        onProjectChatAbort: abortProjectChat,
        onProjectChatReset: resetProjectChat,
        onOpenRequirement: openRequirement,
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

export { buildWorkflowRunEdges } from "./edges";
