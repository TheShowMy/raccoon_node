import React, { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles.css";

import type { SettingsView, StartNodeData, StreamEvent } from "./types/api";
import StartNode from "./components/nodes/StartNode";
import { buildRequirementDagEdges } from "./canvas/edges";
import {
  buildProjectChatNode,
  buildProjectNodes,
  buildProjectTerminalNode,
  mergeProjectNodes,
} from "./canvas/buildProjectNodes";
import { useCurrentProject } from "./hooks/useCurrentProject";
import { useProjectCanvas } from "./hooks/useProjectCanvas";
import { useRequirementFlow } from "./hooks/useRequirementFlow";
import { useProjectChat } from "./hooks/useProjectChat";
import { useModelSettings } from "./hooks/useModelSettings";
import { useProjectTerminals } from "./hooks/useProjectTerminals";
import { RequirementTaskEventsProvider } from "./contexts/RequirementTaskEventsContext";
import {
  getVisibleSettingsViewport,
  type CanvasViewport,
} from "./canvas/settingsViewport";

const nodeTypes = { startNode: StartNode };
const EMPTY_STREAM_EVENTS: StreamEvent[] = [];

export type ProjectViewportSnapshot = {
  projectLoaded: boolean;
  selectedDagRequirementId: string | null;
};

export function getProjectViewportAction(
  previous: ProjectViewportSnapshot,
  current: ProjectViewportSnapshot,
): "fit" | "focus-dag" | null {
  if (!current.projectLoaded) return null;
  if (previous.selectedDagRequirementId && !current.selectedDagRequirementId) {
    return "fit";
  }
  if (
    current.selectedDagRequirementId &&
    current.selectedDagRequirementId !== previous.selectedDagRequirementId
  ) {
    return "focus-dag";
  }
  return null;
}

export function getReactFlowKey({
  projectId,
  projectLoaded,
}: {
  projectId: string | null;
  projectLoaded: boolean;
}) {
  return `project-${projectId ?? "none"}-${projectLoaded ? "ready" : "loading"}`;
}

function ProjectCanvasViewportController({
  projectLoaded,
  selectedDagRequirementId,
}: ProjectViewportSnapshot) {
  const { fitView, getNode, getViewport, setCenter } = useReactFlow();
  const previous = React.useRef<ProjectViewportSnapshot>({
    projectLoaded: false,
    selectedDagRequirementId: null,
  });

  React.useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { projectLoaded, selectedDagRequirementId };

    const action = getProjectViewportAction(last, previous.current);
    if (!action) return;
    if (action === "fit") {
      void fitView({ padding: 0.08, duration: 0 });
      return;
    }

    const timer = window.setTimeout(() => {
      const dagNode = getNode("requirement-dag");
      if (!dagNode) return;

      const width = dagNode.measured?.width ?? dagNode.width ?? 360;
      const height = dagNode.measured?.height ?? dagNode.height ?? 260;
      const zoom = getViewport().zoom;
      void setCenter(
        dagNode.position.x + width / 2,
        dagNode.position.y + height / 2,
        { zoom, duration: 260 },
      );
    }, 80);

    return () => window.clearTimeout(timer);
  }, [
    fitView,
    getNode,
    getViewport,
    projectLoaded,
    selectedDagRequirementId,
    setCenter,
  ]);

  return null;
}

export function getSettingsViewDepth(view: SettingsView) {
  return view === "closed" ? 0 : view === "list" ? 1 : 2;
}

export function updateSettingsViewportStack(
  previous: SettingsView,
  current: SettingsView,
  stack: CanvasViewport[],
  viewport: CanvasViewport,
) {
  const previousDepth = getSettingsViewDepth(previous);
  const currentDepth = getSettingsViewDepth(current);
  if (currentDepth > previousDepth) {
    stack.push(viewport);
    return;
  }
  let saved: CanvasViewport | undefined;
  for (let depth = previousDepth; depth > currentDepth; depth -= 1) {
    saved = stack.pop() ?? saved;
  }
  return saved;
}

function SettingsViewportController({
  settingsView,
}: {
  settingsView: SettingsView;
}) {
  const { getNode, getViewport, setViewport } = useReactFlow();
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const previousView = React.useRef<SettingsView>("closed");
  const viewportStack = React.useRef<CanvasViewport[]>([]);

  React.useLayoutEffect(() => {
    const previous = previousView.current;
    if (previous === settingsView) return;
    previousView.current = settingsView;

    const saved = updateSettingsViewportStack(
      previous,
      settingsView,
      viewportStack.current,
      getViewport(),
    );
    if (saved) {
      void setViewport(saved, { duration: 260 });
      return;
    }

    const targetId =
      settingsView === "list"
        ? "settings-list"
        : settingsView === "basic"
          ? "basic-settings"
          : settingsView === "models"
            ? "model-config"
            : null;
    if (!targetId) return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const node = getNode(targetId);
        if (!node) return;
        const width = node.measured?.width ?? node.width;
        const height = node.measured?.height ?? node.height;
        if (!width || !height) return;

        const viewport = getViewport();
        const next = getVisibleSettingsViewport(
          viewport,
          { width: canvasWidth, height: canvasHeight },
          { ...node.position, width, height },
          settingsView === "models" ? { horizontal: 230, vertical: 24 } : 24,
        );
        if (next !== viewport) void setViewport(next, { duration: 260 });
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [
    canvasHeight,
    canvasWidth,
    getNode,
    getViewport,
    setViewport,
    settingsView,
  ]);

  return null;
}

function minimapNodeColor(node: Node<StartNodeData>): string {
  switch (node.data.kind) {
    case "requirement-chat":
      return "#f97316";
    case "project-terminal":
      return "#14b8a6";
    case "requirement-list":
      return node.data.tone === "done" ? "#22c55e" : "#f59e0b";
    case "requirement-dag":
      return "#a855f7";
    case "requirement-task":
      return "#6366f1";
    case "token-usage":
      return "#22c55e";
    case "basic-settings":
    case "model-config":
    case "settings-list":
    case "summary":
      return "#f97316";
    default:
      return "#94a3b8";
  }
}

export default function App() {
  useEffect(() => {
    if (window.location.pathname !== "/") {
      window.history.replaceState(
        null,
        "",
        `/${window.location.search}${window.location.hash}`,
      );
    }
  }, []);
  const current = useCurrentProject();
  const selectedProjectId = current.project?.id ?? null;
  const project = useProjectCanvas(selectedProjectId, current.setError);
  const requirement = useRequirementFlow(
    selectedProjectId,
    project.activeRequirementId,
    project.observedRequirementId,
    project.setProjectCanvas,
    project.loadProjectCanvas,
    project.setSelectedDagRequirementId,
  );
  const projectChat = useProjectChat(selectedProjectId);
  const models = useModelSettings(current.applyTheme);
  const terminals = useProjectTerminals(
    selectedProjectId,
    models.basicSettings?.host === "0.0.0.0",
  );
  const [nodeDragging, setNodeDragging] = useState(false);
  const requirementConversationEvents = project.selectedDagRequirementId
    ? EMPTY_STREAM_EVENTS
    : requirement.requirementStreamEvents;

  const projectStructureNodes = useMemo(
    () =>
      buildProjectNodes({
        projectCanvas: project.projectCanvas,
        project: current.project,
        publicationReadiness: current.publicationReadiness,
        selectedDagRequirement: project.selectedDagRequirement,
        selectedDagRequirementId: project.selectedDagRequirementId,
        collapsedTaskGroups: project.collapsedTaskGroups,
        requirementActionBusyId: project.requirementActionBusyId,
        recoveringTaskGroupIds: project.recoveringTaskGroupIds,
        requirementActionError: project.requirementActionError,
        settingsView: models.settingsView,
        basicSettings: models.basicSettings,
        basicSettingsError: models.basicSettingsError,
        savingBasicSettings: models.savingBasicSettings,
        draftModelSettings: models.draftModelSettings,
        models: models.models,
        modelRpcStatus: models.modelRpcStatus,
        modelError: models.modelError,
        savingModels: models.savingModels,
        openSettings: models.openSettings,
        openBasicSettings: models.openBasicSettings,
        openModelSettings: models.openModelSettings,
        closeSettingsDetail: models.closeSettingsDetail,
        closeSettingsList: models.closeSettingsList,
        updateBasicSettings: models.updateBasicSettings,
        saveBasicSettings: models.saveBasicSettings,
        updateModelTier: models.updateModelTier,
        saveModelSettings: models.saveModelSettings,
        closeDag: project.closeDag,
        selectDagRequirement: project.selectDagRequirement,
        planRequirement: project.planRequirement,
        recoverTaskGroup: project.recoverTaskGroup,
        toggleTaskGroupCollapsed: project.toggleTaskGroupCollapsed,
      }),
    [
      current.project,
      current.publicationReadiness,
      models.basicSettings,
      models.basicSettingsError,
      models.closeSettingsDetail,
      models.closeSettingsList,
      models.draftModelSettings,
      models.modelError,
      models.modelRpcStatus,
      models.models,
      models.openBasicSettings,
      models.openModelSettings,
      models.openSettings,
      models.saveBasicSettings,
      models.saveModelSettings,
      models.savingBasicSettings,
      models.savingModels,
      models.settingsView,
      models.updateBasicSettings,
      models.updateModelTier,
      project.closeDag,
      project.collapsedTaskGroups,
      project.planRequirement,
      project.projectCanvas,
      project.recoveringTaskGroupIds,
      project.requirementActionBusyId,
      project.requirementActionError,
      project.recoverTaskGroup,
      project.selectDagRequirement,
      project.selectedDagRequirement,
      project.selectedDagRequirementId,
      project.toggleTaskGroupCollapsed,
    ],
  );

  const projectChatNode = useMemo(
    () =>
      buildProjectChatNode({
        projectCanvas: project.projectCanvas,
        project: current.project,
        requirementConversation: requirement.requirementConversation,
        requirementInput: requirement.requirementInput,
        requirementReferences: requirement.requirementReferences,
        requirementImages: requirement.requirementImages,
        requirementBusy: requirement.requirementBusy,
        requirementError: requirement.requirementError,
        requirementStreamEvents: requirementConversationEvents,
        projectChat: projectChat.projectChat,
        projectChatInput: projectChat.projectChatInput,
        projectChatReferences: projectChat.projectChatReferences,
        projectChatImages: projectChat.projectChatImages,
        projectChatBusy: projectChat.projectChatBusy,
        projectChatError: projectChat.projectChatError,
        projectChatEvents: projectChat.projectChatEvents,
        clarificationAnswers: requirement.clarificationAnswers,
        dismissedPromptRequirementId: requirement.dismissedPromptRequirementId,
        setRequirementInput: requirement.setRequirementInput,
        setRequirementReferences: requirement.setRequirementReferences,
        setRequirementImages: requirement.setRequirementImages,
        sendRequirementMessage: requirement.sendRequirementMessage,
        setProjectChatInput: projectChat.setProjectChatInput,
        setProjectChatReferences: projectChat.setProjectChatReferences,
        setProjectChatImages: projectChat.setProjectChatImages,
        sendProjectChatMessage: projectChat.sendProjectChat,
        resetProjectChat: projectChat.closeProjectChat,
        updateClarificationAnswer: requirement.updateClarificationAnswer,
        submitClarifications: requirement.submitClarifications,
        confirmRequirement: requirement.confirmRequirement,
        retryRequirementAnalysis: requirement.retryRequirementAnalysis,
        continueEditingRequirement: requirement.continueEditingRequirement,
        cancelRequirementAnalysis: project.cancelRequirementAnalysis,
        abandonRequirement: project.abandonRequirement,
      }),
    [
      current.project,
      project.abandonRequirement,
      project.cancelRequirementAnalysis,
      project.projectCanvas,
      projectChat.closeProjectChat,
      projectChat.projectChat,
      projectChat.projectChatBusy,
      projectChat.projectChatError,
      projectChat.projectChatEvents,
      projectChat.projectChatImages,
      projectChat.projectChatInput,
      projectChat.projectChatReferences,
      projectChat.sendProjectChat,
      projectChat.setProjectChatImages,
      projectChat.setProjectChatInput,
      projectChat.setProjectChatReferences,
      requirement.clarificationAnswers,
      requirement.confirmRequirement,
      requirement.retryRequirementAnalysis,
      requirement.continueEditingRequirement,
      requirement.dismissedPromptRequirementId,
      requirement.requirementBusy,
      requirement.requirementConversation,
      requirement.requirementError,
      requirement.requirementImages,
      requirement.requirementInput,
      requirement.requirementReferences,
      requirementConversationEvents,
      requirement.sendRequirementMessage,
      requirement.setRequirementImages,
      requirement.setRequirementInput,
      requirement.setRequirementReferences,
      requirement.submitClarifications,
      requirement.updateClarificationAnswer,
    ],
  );

  const projectTerminalNode = useMemo(
    () =>
      buildProjectTerminalNode({
        projectCanvas: project.projectCanvas,
        project: current.project,
        collapsed: terminals.collapsed,
        sessions: terminals.sessions,
        activeSessionId: terminals.activeSessionId,
        commandProfiles: terminals.commandProfiles,
        busy: terminals.busy,
        error: terminals.error,
        terminalDisabled: models.basicSettings?.host === "0.0.0.0",
        onToggleCollapsed: terminals.toggleCollapsed,
        onCreateTerminal: terminals.createTerminal,
        onCloseTerminal: terminals.closeTerminal,
        onSelectTerminal: terminals.selectTerminal,
        onSaveCommandProfiles: terminals.saveCommandProfiles,
      }),
    [
      current.project,
      models.basicSettings?.host,
      project.projectCanvas,
      terminals.activeSessionId,
      terminals.busy,
      terminals.closeTerminal,
      terminals.collapsed,
      terminals.commandProfiles,
      terminals.createTerminal,
      terminals.error,
      terminals.saveCommandProfiles,
      terminals.selectTerminal,
      terminals.sessions,
      terminals.toggleCollapsed,
    ],
  );

  const nodes = useMemo(
    () =>
      mergeProjectNodes(
        projectStructureNodes,
        projectChatNode,
        projectTerminalNode,
      ),
    [projectChatNode, projectStructureNodes, projectTerminalNode],
  );

  const edges = useMemo<Edge[]>(() => {
    const flowEdges: Edge[] = project.selectedDagRequirement
      ? []
      : [
          {
            id: "completed-requirements-to-requirement-chat",
            source: "completed-requirements",
            sourceHandle: "requirement-list-right",
            target: "requirement-chat",
            targetHandle: "requirement-chat-left",
            type: "smoothstep",
            animated: true,
            style: { stroke: "rgba(20, 184, 166, 0.62)", strokeWidth: 2 },
          },
          {
            id: "requirement-chat-to-queued-requirements",
            source: "requirement-chat",
            sourceHandle: "requirement-chat-right",
            target: "queued-requirements",
            targetHandle: "requirement-list-left",
            type: "smoothstep",
            animated: true,
            style: { stroke: "rgba(249, 115, 22, 0.68)", strokeWidth: 2 },
          },
        ];

    if (project.selectedDagRequirement) {
      flowEdges.push(
        ...buildRequirementDagEdges(
          project.selectedDagRequirement,
          project.collapsedTaskGroups,
        ),
      );
    }
    if (models.settingsView !== "closed") {
      flowEdges.push({
        id: "settings-to-settings-list",
        source: "settings",
        sourceHandle: "settings-left-source",
        target: "settings-list",
        targetHandle: "settings-list-right",
        type: "smoothstep",
        animated: true,
        style: { stroke: "rgba(249, 115, 22, 0.68)", strokeWidth: 2 },
      });
    }
    const settingsDetail =
      models.settingsView === "basic"
        ? "basic-settings"
        : models.settingsView === "models"
          ? "model-config"
          : null;
    if (settingsDetail) {
      flowEdges.push({
        id: `settings-list-to-${settingsDetail}`,
        source: "settings-list",
        sourceHandle: "settings-list-left-source",
        target: settingsDetail,
        targetHandle: "settings-detail-right",
        type: "smoothstep",
        animated: true,
        style: { stroke: "rgba(249, 115, 22, 0.68)", strokeWidth: 2 },
      });
    }
    return flowEdges;
  }, [
    models.settingsView,
    project.collapsedTaskGroups,
    project.selectedDagRequirement,
  ]);

  return (
    <main className="app-shell" data-theme={current.theme}>
      <section className="toolbar">
        <div>
          <h1>Raccoon Node</h1>
          <p>
            {current.project
              ? `${current.project.name} / 项目画布`
              : "项目画布"}
          </p>
        </div>
        <div className="status-pill">
          {current.error
            ? current.error
            : current.loading
              ? "加载中"
              : "已连接"}
        </div>
      </section>
      <section
        className={`canvas-shell${nodeDragging ? " canvas-shell--dragging" : ""}`}
      >
        <RequirementTaskEventsProvider
          requirementId={project.observedRequirementId}
          events={requirement.requirementStreamEvents}
        >
          <ReactFlowProvider>
            <ReactFlow
              key={getReactFlowKey({
                projectId: selectedProjectId,
                projectLoaded: Boolean(project.projectCanvas),
              })}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.08, duration: 0 }}
              minZoom={0.05}
              maxZoom={2}
              nodesDraggable
              onNodeDragStart={() => setNodeDragging(true)}
              onNodeDragStop={() => setNodeDragging(false)}
              nodesConnectable={false}
              elementsSelectable
              panOnScroll
              panActivationKeyCode="Space"
              selectionOnDrag
              defaultEdgeOptions={{
                type: "smoothstep",
                style: { strokeWidth: 2 },
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  width: 12,
                  height: 12,
                },
              }}
            >
              <Background color="rgba(148, 163, 184, 0.18)" gap={24} />
              <MiniMap
                position="bottom-left"
                pannable
                zoomable
                nodeColor={minimapNodeColor}
                nodeStrokeWidth={2}
                nodeStrokeColor="rgba(255, 255, 255, 0.5)"
              />
              <Controls position="bottom-right" />
              <ProjectCanvasViewportController
                projectLoaded={Boolean(project.projectCanvas)}
                selectedDagRequirementId={project.selectedDagRequirementId}
              />
              <SettingsViewportController settingsView={models.settingsView} />
            </ReactFlow>
          </ReactFlowProvider>
        </RequirementTaskEventsProvider>
      </section>
    </main>
  );
}
