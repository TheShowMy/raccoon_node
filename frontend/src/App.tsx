import React, { useEffect, useMemo } from "react";
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles.css";

import type { StartNodeData } from "./types/api";
import StartNode from "./components/nodes/StartNode";
import { buildRequirementDagEdges } from "./canvas/edges";
import {
  buildProjectChatNode,
  buildProjectNodes,
  mergeProjectNodes,
} from "./canvas/buildProjectNodes";
import { useCurrentProject } from "./hooks/useCurrentProject";
import { useProjectCanvas } from "./hooks/useProjectCanvas";
import { useRequirementFlow } from "./hooks/useRequirementFlow";
import { useProjectChat } from "./hooks/useProjectChat";
import { useModelSettings } from "./hooks/useModelSettings";
import { RequirementTaskEventsProvider } from "./contexts/RequirementTaskEventsContext";

const nodeTypes = { startNode: StartNode };

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

function minimapNodeColor(node: Node<StartNodeData>): string {
  switch (node.data.kind) {
    case "requirement-chat":
      return "#f97316";
    case "requirement-list":
      return node.data.tone === "done" ? "#22c55e" : "#f59e0b";
    case "requirement-dag":
      return "#a855f7";
    case "requirement-task":
      return "#6366f1";
    case "token-usage":
      return "#22c55e";
    case "model-config":
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
  const models = useModelSettings();

  const projectStructureNodes = useMemo(
    () =>
      buildProjectNodes({
        projectCanvas: project.projectCanvas,
        project: current.project,
        selectedDagRequirement: project.selectedDagRequirement,
        selectedDagRequirementId: project.selectedDagRequirementId,
        collapsedTaskGroups: project.collapsedTaskGroups,
        requirementActionBusyId: project.requirementActionBusyId,
        requirementActionError: project.requirementActionError,
        modelSettingsOpen: models.modelSettingsOpen,
        draftModelSettings: models.draftModelSettings,
        models: models.models,
        modelRpcStatus: models.modelRpcStatus,
        modelError: models.modelError,
        savingModels: models.savingModels,
        setModelSettingsOpen: models.setModelSettingsOpen,
        toggleModelSettings: models.toggleModelSettings,
        updateModelTier: models.updateModelTier,
        saveModelSettings: models.saveModelSettings,
        closeDag: project.closeDag,
        selectDagRequirement: project.selectDagRequirement,
        planRequirement: project.planRequirement,
        retryFailedNode: project.retryFailedNode,
        retryFromNode: project.retryFromNode,
        rerunReview: project.rerunReview,
        toggleTaskGroupCollapsed: project.toggleTaskGroupCollapsed,
      }),
    [
      current.project,
      models.draftModelSettings,
      models.modelError,
      models.modelRpcStatus,
      models.modelSettingsOpen,
      models.models,
      models.saveModelSettings,
      models.savingModels,
      models.setModelSettingsOpen,
      models.toggleModelSettings,
      models.updateModelTier,
      project.closeDag,
      project.collapsedTaskGroups,
      project.planRequirement,
      project.projectCanvas,
      project.requirementActionBusyId,
      project.requirementActionError,
      project.rerunReview,
      project.retryFailedNode,
      project.retryFromNode,
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
        requirementStreamEvents: requirement.requirementStreamEvents,
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
      requirement.continueEditingRequirement,
      requirement.dismissedPromptRequirementId,
      requirement.requirementBusy,
      requirement.requirementConversation,
      requirement.requirementError,
      requirement.requirementImages,
      requirement.requirementInput,
      requirement.requirementReferences,
      requirement.requirementStreamEvents,
      requirement.sendRequirementMessage,
      requirement.setRequirementImages,
      requirement.setRequirementInput,
      requirement.setRequirementReferences,
      requirement.submitClarifications,
      requirement.updateClarificationAnswer,
    ],
  );

  const nodes = useMemo(
    () => mergeProjectNodes(projectStructureNodes, projectChatNode),
    [projectChatNode, projectStructureNodes],
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
    if (models.modelSettingsOpen) {
      flowEdges.push({
        id: "model-settings-to-model-config",
        source: "model-settings",
        sourceHandle: "model-left-source",
        target: "model-config",
        targetHandle: "model-left",
        type: "smoothstep",
        animated: true,
        style: { stroke: "rgba(249, 115, 22, 0.68)", strokeWidth: 2 },
      });
    }
    return flowEdges;
  }, [
    models.modelSettingsOpen,
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
      <section className="canvas-shell">
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
            </ReactFlow>
          </ReactFlowProvider>
        </RequirementTaskEventsProvider>
      </section>
    </main>
  );
}
