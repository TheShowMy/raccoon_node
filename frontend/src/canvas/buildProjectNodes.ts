import type { Node } from "@xyflow/react";
import type {
  ChatSubmission,
  DraftClarificationAnswer,
  BasicSettings,
  BasicSettingsUpdate,
  FileReference,
  ImageAttachment,
  Project,
  ProjectCanvasData,
  Requirement,
  RequirementConversation,
  RequirementTimelineBranch,
  RequirementExecutionTask,
  ConversationEvent,
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
  ModelSettings,
  ModelTierKey,
  ModelTierSetting,
  PiModel,
  SettingsPage,
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
      "project-settings": { width: 960, height: 44 },
      "requirement-list": { width: 360, height: 760 },
      "requirement-chat": { width: 960, height: 760 },
      "project-terminal": { width: 960, height: 44 },
      "project-git": { width: 360, height: 44 },
      "requirement-dag": DAG_NODE_SIZE,
      "requirement-task": { width: 252, height: 134 },
      "token-usage": { width: 360, height: 44 },
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
  selectedDagRequirement: Requirement | null;
  selectedDagRequirementId: string | null;
  collapsedTaskGroups: Set<string>;
  requirementActionBusyId: string | null;
  recoveringTaskGroupIds: Set<string>;
  requirementActionError: string | null;
  tokenUsageExpanded: boolean;
  closeDag: () => void;
  selectDagRequirement: (requirement: Requirement) => void;
  planRequirement: (requirement: Requirement) => Promise<void>;
  recoverTaskGroup: (requirementId: string, taskId: string) => Promise<void>;
  toggleTaskGroupCollapsed: (requirementId: string, taskId: string) => void;
  onToggleTokenUsageExpanded: () => void;
}

export interface BuildProjectSettingsNodeParams {
  projectCanvas: ProjectCanvasData | null;
  project: Project | null;
  expanded: boolean;
  page: SettingsPage;
  basicSettings: BasicSettings | null;
  basicError: string | null;
  savingBasic: boolean;
  savingTheme: boolean;
  modelSettings: ModelSettings;
  models: PiModel[];
  modelRpcStatus: "idle" | "loading" | "ready" | "reconnecting" | "error";
  modelError: string | null;
  savingModels: boolean;
  terminalDisabled: boolean;
  terminalAccessRequired: boolean;
  terminalAccessAuthorized: boolean;
  terminalAccessBusy: boolean;
  terminalAccessError: string | null;
  piLoginSession: TerminalSession | null;
  piLoginBusy: boolean;
  piLoginError: string | null;
  needsModelOnboarding: boolean;
  modelDraftComplete: boolean;
  modelSavedComplete: boolean;
  onToggleExpanded: () => void;
  onOpenBasic: () => void;
  onOpenModels: () => void;
  onBasicChange: (settings: BasicSettings) => void;
  onThemeChange: (
    update: Pick<BasicSettingsUpdate, "theme_pack" | "theme_mode">,
  ) => Promise<void>;
  onSaveBasic: (confirmedExternal?: boolean) => Promise<BasicSettings | null>;
  onModelChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
  onSaveModels: () => Promise<void>;
  onReloadModels: () => Promise<void>;
  onAuthorizeTerminalAccess: (key: string) => Promise<boolean>;
  onStartPiLogin: () => Promise<void>;
  onClosePiLogin: () => Promise<void>;
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
  terminalAccessRequired: boolean;
  terminalAccessAuthorized: boolean;
  terminalAccessExpiresAt: string | null;
  terminalAccessBusy: boolean;
  terminalAccessError: string | null;
  onToggleCollapsed: () => void;
  onAuthorizeTerminalAccess: (key: string) => Promise<boolean>;
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
  requirementTimeline: RequirementTimelineBranch[];
  hasOlderRequirementHistory: boolean;
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
  loadOlderRequirementHistory: () => Promise<boolean>;
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
  selectedDagRequirement,
  selectedDagRequirementId,
  collapsedTaskGroups,
  requirementActionBusyId,
  recoveringTaskGroupIds,
  requirementActionError,
  tokenUsageExpanded,
  closeDag,
  selectDagRequirement,
  planRequirement,
  recoverTaskGroup,
  toggleTaskGroupCollapsed,
  onToggleTokenUsageExpanded,
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
      id: "requirements",
      type: "startNode",
      position: { x: 984, y: 20 },
      style: { width: 360, height: 760 },
      data: {
        kind: "requirement-list",
        pendingRequirements: projectCanvas?.queued_requirements ?? [],
        completedRequirements: projectCanvas?.completed_requirements ?? [],
        selectedRequirementId: selectedDagRequirementId,
        busyRequirementId: requirementActionBusyId,
        onSelectRequirement: selectDagRequirement,
        onPlanRequirement: planRequirement,
      },
    },
    {
      id: "token-usage",
      type: "startNode",
      className: "token-usage-flow-node",
      position: tokenUsageExpanded ? { x: 984, y: -240 } : { x: 984, y: -44 },
      style: {
        width: 360,
        height: tokenUsageExpanded ? 240 : 44,
        zIndex: tokenUsageExpanded ? 20 : 1,
      },
      data: {
        kind: "token-usage",
        usage: projectCanvas?.token_usage ?? null,
        expanded: tokenUsageExpanded,
        onToggleExpanded: onToggleTokenUsageExpanded,
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
                  height: collapsed ? 76 : groupLayout.height,
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
  requirementTimeline,
  hasOlderRequirementHistory,
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
  loadOlderRequirementHistory,
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
        requirementTimeline,
        hasOlderRequirementHistory,
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
        onLoadOlderRequirementHistory: loadOlderRequirementHistory,
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

export function buildProjectSettingsNode({
  projectCanvas,
  project: currentProject,
  expanded,
  page,
  basicSettings,
  basicError,
  savingBasic,
  savingTheme,
  modelSettings,
  models,
  modelRpcStatus,
  modelError,
  savingModels,
  terminalDisabled,
  terminalAccessRequired,
  terminalAccessAuthorized,
  terminalAccessBusy,
  terminalAccessError,
  piLoginSession,
  piLoginBusy,
  piLoginError,
  needsModelOnboarding,
  modelDraftComplete,
  modelSavedComplete,
  onToggleExpanded,
  onOpenBasic,
  onOpenModels,
  onBasicChange,
  onThemeChange,
  onSaveBasic,
  onModelChange,
  onSaveModels,
  onReloadModels,
  onAuthorizeTerminalAccess,
  onStartPiLogin,
  onClosePiLogin,
}: BuildProjectSettingsNodeParams): Node<StartNodeData> | null {
  const project = projectCanvas?.project ?? currentProject;
  if (!project) return null;

  return withDimensions([
    {
      id: "project-settings",
      type: "startNode",
      position: expanded ? { x: -180, y: -800 } : { x: 0, y: -44 },
      style: {
        width: expanded ? 1320 : 960,
        height: expanded ? 780 : 44,
        zIndex: expanded ? 20 : 1,
      },
      data: {
        kind: "project-settings",
        expanded,
        page,
        basicSettings,
        basicError,
        savingBasic,
        savingTheme,
        modelSettings,
        models,
        modelRpcStatus,
        modelError,
        savingModels,
        terminalDisabled,
        terminalAccessRequired,
        terminalAccessAuthorized,
        terminalAccessBusy,
        terminalAccessError,
        piLoginSession,
        piLoginBusy,
        piLoginError,
        needsModelOnboarding,
        modelDraftComplete,
        modelSavedComplete,
        onToggleExpanded,
        onOpenBasic,
        onOpenModels,
        onBasicChange,
        onThemeChange,
        onSaveBasic,
        onModelChange,
        onSaveModels,
        onReloadModels,
        onAuthorizeTerminalAccess,
        onStartPiLogin,
        onClosePiLogin,
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
  terminalAccessRequired,
  terminalAccessAuthorized,
  terminalAccessExpiresAt,
  terminalAccessBusy,
  terminalAccessError,
  onToggleCollapsed,
  onAuthorizeTerminalAccess,
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
        width: 960,
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
        terminalAccessRequired,
        terminalAccessAuthorized,
        terminalAccessExpiresAt,
        terminalAccessBusy,
        terminalAccessError,
        onToggleCollapsed,
        onAuthorizeTerminalAccess,
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
      className: "git-flow-node",
      position: { x: 984, y: 800 },
      style: {
        width: phase === "expanded" ? 1320 : 360,
        height: phase === "collapsed" ? 44 : 780,
        zIndex: phase === "expanded" ? 20 : 1,
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
