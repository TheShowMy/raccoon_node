import React, { useMemo } from "react";
import {
  Background,
  Controls,
  Edge,
  MarkerType,
  MiniMap,
  Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles.css";

import type { StartNodeData } from "./types/api";

import StartNode from "./components/nodes/StartNode";
import { buildRequirementDagEdges } from "./canvas/edges";
import { buildStartNodes } from "./canvas/buildStartNodes";
import { buildProjectNodes } from "./canvas/buildProjectNodes";
import { useStartData } from "./hooks/useStartData";
import { useProjectCanvas } from "./hooks/useProjectCanvas";
import { useRequirementFlow } from "./hooks/useRequirementFlow";
import { useModelSettings } from "./hooks/useModelSettings";

const nodeTypes = { startNode: StartNode };

export type ProjectViewportSnapshot = {
  currentCanvas: "start" | "project";
  projectLoaded: boolean;
  selectedDagRequirementId: string | null;
};

export function getProjectViewportAction(
  previous: ProjectViewportSnapshot,
  current: ProjectViewportSnapshot,
): "fit" | "focus-dag" | null {
  if (current.currentCanvas !== "project" || !current.projectLoaded) {
    return null;
  }
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
  currentCanvas,
  selectedProjectId,
  projectLoaded,
}: {
  currentCanvas: "start" | "project";
  selectedProjectId: string | null;
  projectLoaded: boolean;
}) {
  if (currentCanvas === "start") {
    return "start";
  }
  return `project-${selectedProjectId ?? "none"}-${projectLoaded ? "ready" : "loading"}`;
}

function FitViewOnGraphChange({
  enabled,
  nodeCount,
  edgeCount,
}: {
  enabled: boolean;
  nodeCount: number;
  edgeCount: number;
}) {
  const { fitView } = useReactFlow();

  React.useEffect(() => {
    if (!enabled) return;

    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.08, duration: 260 });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [edgeCount, fitView, nodeCount]);

  return null;
}

function ProjectCanvasViewportController({
  currentCanvas,
  projectLoaded,
  selectedDagRequirementId,
}: {
  currentCanvas: "start" | "project";
  projectLoaded: boolean;
  selectedDagRequirementId: string | null;
}) {
  const { fitView, getNode, getViewport, setCenter } = useReactFlow();
  const previous = React.useRef<{
    currentCanvas: "start" | "project";
    projectLoaded: boolean;
    selectedDagRequirementId: string | null;
  }>({
    currentCanvas: "start",
    projectLoaded: false,
    selectedDagRequirementId: null,
  });

  React.useLayoutEffect(() => {
    const last = previous.current;
    previous.current = {
      currentCanvas,
      projectLoaded,
      selectedDagRequirementId:
        currentCanvas === "project" ? selectedDagRequirementId : null,
    };

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
    currentCanvas,
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
    case "create":
      return "#3b82f6";
    case "projects":
      return "#14b8a6";
    case "project-item":
      return "#0ea5e9";
    case "requirement-chat":
      return "#f97316";
    case "requirement-list":
      return node.data.tone === "done" ? "#22c55e" : "#f59e0b";
    case "requirement-dag":
      return "#a855f7";
    case "requirement-task":
      return "#6366f1";
    case "model-config":
    case "summary":
      return "#f97316";
    case "delete-confirm":
      return "#fb7185";
    default:
      return "#94a3b8";
  }
}

export default function App() {
  const start = useStartData();
  const project = useProjectCanvas(
    start.selectedProjectId,
    start.currentCanvas,
    start.setError,
    start.setCurrentCanvas,
    start.setSelectedProjectId,
  );
  const requirement = useRequirementFlow(
    start.selectedProjectId,
    project.activeRequirementId,
    project.observedRequirementId,
    project.setProjectCanvas,
    project.loadProjectCanvas,
  );
  const models = useModelSettings(start.loadStart);

  const startNodes = useMemo(
    () =>
      buildStartNodes({
        startData: start.startData,
        theme: start.theme,
        creating: start.creating,
        error: start.error,
        pendingDeleteProject: start.pendingDeleteProject,
        deletingId: start.deletingId,
        deleteError: start.deleteError,
        modelSettingsOpen: models.modelSettingsOpen,
        draftModelSettings: models.draftModelSettings,
        models: models.models,
        modelRpcStatus: models.modelRpcStatus,
        modelError: models.modelError,
        savingModels: models.savingModels,
        setTheme: start.setTheme,
        createProject: start.createProject,
        requestDeleteProject: start.requestDeleteProject,
        cancelDeleteProject: start.cancelDeleteProject,
        confirmDeleteProject: start.confirmDeleteProject,
        setModelSettingsOpen: models.setModelSettingsOpen,
        toggleModelSettings: models.toggleModelSettings,
        updateModelTier: models.updateModelTier,
        saveModelSettings: models.saveModelSettings,
        openProjectCanvas: start.openProjectCanvas,
      }),
    [
      start.startData,
      start.theme,
      start.creating,
      start.error,
      start.pendingDeleteProject,
      start.deletingId,
      start.deleteError,
      start.setTheme,
      start.createProject,
      start.requestDeleteProject,
      start.cancelDeleteProject,
      start.confirmDeleteProject,
      start.openProjectCanvas,
      models.modelSettingsOpen,
      models.draftModelSettings,
      models.models,
      models.modelRpcStatus,
      models.modelError,
      models.savingModels,
      models.setModelSettingsOpen,
      models.toggleModelSettings,
      models.updateModelTier,
      models.saveModelSettings,
    ],
  );

  const projectNodes = useMemo(
    () =>
      buildProjectNodes({
        projectCanvas: project.projectCanvas,
        selectedProjectId: start.selectedProjectId,
        startProjects: start.startData.projects,
        selectedDagRequirement: project.selectedDagRequirement,
        selectedDagRequirementId: project.selectedDagRequirementId,
        observedRequirementId: project.observedRequirementId,
        collapsedTaskGroups: project.collapsedTaskGroups,
        requirementActionBusyId: project.requirementActionBusyId,
        requirementActionError: project.requirementActionError,
        requirementConversation: requirement.requirementConversation,
        requirementInput: requirement.requirementInput,
        requirementBusy: requirement.requirementBusy,
        requirementError: requirement.requirementError,
        requirementStreamEvents: requirement.requirementStreamEvents,
        clarificationAnswers: requirement.clarificationAnswers,
        dismissedPromptRequirementId: requirement.dismissedPromptRequirementId,
        backToStartCanvas: start.backToStartCanvas,
        closeDag: project.closeDag,
        selectDagRequirement: project.selectDagRequirement,
        planRequirement: project.planRequirement,
        startExecution: project.startExecution,
        retryFailedNode: project.retryFailedNode,
        retryFromNode: project.retryFromNode,
        rerunReview: project.rerunReview,
        setRequirementInput: requirement.setRequirementInput,
        sendRequirementMessage: requirement.sendRequirementMessage,
        updateClarificationAnswer: requirement.updateClarificationAnswer,
        submitClarifications: requirement.submitClarifications,
        confirmRequirement: requirement.confirmRequirement,
        continueEditingRequirement: requirement.continueEditingRequirement,
        toggleTaskGroupCollapsed: project.toggleTaskGroupCollapsed,
        cancelRequirementAnalysis: project.cancelRequirementAnalysis,
      }),
    [
      project.projectCanvas,
      project.selectedDagRequirement,
      project.selectedDagRequirementId,
      project.observedRequirementId,
      project.collapsedTaskGroups,
      project.requirementActionBusyId,
      project.requirementActionError,
      project.closeDag,
      project.selectDagRequirement,
      project.planRequirement,
      project.startExecution,
      project.retryFailedNode,
      project.retryFromNode,
      project.rerunReview,
      project.toggleTaskGroupCollapsed,
      start.selectedProjectId,
      start.startData.projects,
      start.backToStartCanvas,
      requirement.requirementConversation,
      requirement.requirementInput,
      requirement.requirementBusy,
      requirement.requirementError,
      requirement.requirementStreamEvents,
      requirement.clarificationAnswers,
      requirement.dismissedPromptRequirementId,
      requirement.setRequirementInput,
      requirement.sendRequirementMessage,
      requirement.updateClarificationAnswer,
      requirement.submitClarifications,
      requirement.confirmRequirement,
      requirement.continueEditingRequirement,
    ],
  );

  const nodes = start.currentCanvas === "project" ? projectNodes : startNodes;

  const projectEdges = useMemo<Edge[]>(() => {
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
            style: {
              stroke: "rgba(20, 184, 166, 0.62)",
              strokeWidth: 2,
            },
          },
          {
            id: "requirement-chat-to-queued-requirements",
            source: "requirement-chat",
            sourceHandle: "requirement-chat-right",
            target: "queued-requirements",
            targetHandle: "requirement-list-left",
            type: "smoothstep",
            animated: true,
            style: {
              stroke: "rgba(249, 115, 22, 0.68)",
              strokeWidth: 2,
            },
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

    return flowEdges;
  }, [project.selectedDagRequirement, project.collapsedTaskGroups]);

  const startEdges = useMemo<Edge[]>(() => {
    const flowEdges: Edge[] = [
      {
        id: "create-project-to-project-list",
        source: "create-project",
        sourceHandle: "left-link",
        target: "project-list",
        targetHandle: "left-link",
        type: "smoothstep",
        animated: true,
        style: {
          stroke: "rgba(20, 184, 166, 0.56)",
          strokeWidth: 2,
        },
      },
    ];

    if (start.pendingDeleteProject) {
      flowEdges.push({
        id: `project-item-delete-confirm-${start.pendingDeleteProject.id}`,
        source: `project-item-${start.pendingDeleteProject.id}`,
        sourceHandle: "delete-right",
        target: `delete-confirm-${start.pendingDeleteProject.id}`,
        targetHandle: "delete-left",
        type: "smoothstep",
        animated: true,
        style: {
          stroke: "rgba(251, 113, 133, 0.72)",
          strokeDasharray: "6 6",
          strokeWidth: 2,
        },
      });
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
        style: {
          stroke: "rgba(249, 115, 22, 0.68)",
          strokeWidth: 2,
        },
      });
    }

    return flowEdges;
  }, [start.pendingDeleteProject, models.modelSettingsOpen]);

  const edges = start.currentCanvas === "project" ? projectEdges : startEdges;
  const flowKey = getReactFlowKey({
    currentCanvas: start.currentCanvas,
    selectedProjectId: start.selectedProjectId,
    projectLoaded: Boolean(project.projectCanvas),
  });

  return (
    <main className="app-shell" data-theme={start.theme}>
      <section className="toolbar">
        <div>
          <h1>Raccoon Node</h1>
          <p>
            {start.currentCanvas === "project" && project.projectCanvas
              ? `${project.projectCanvas.project.name} / 项目画布`
              : "Start 画布"}
          </p>
        </div>
        <div className="status-pill">{start.loading ? "加载中" : "已连接"}</div>
      </section>
      <section className="canvas-shell">
        <ReactFlowProvider>
          <ReactFlow
            key={flowKey}
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
            <FitViewOnGraphChange
              enabled={start.currentCanvas === "start"}
              nodeCount={nodes.length}
              edgeCount={edges.length}
            />
            <ProjectCanvasViewportController
              currentCanvas={start.currentCanvas}
              projectLoaded={Boolean(project.projectCanvas)}
              selectedDagRequirementId={project.selectedDagRequirementId}
            />
          </ReactFlow>
        </ReactFlowProvider>
      </section>
    </main>
  );
}
