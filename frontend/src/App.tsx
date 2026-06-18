import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Edge,
  Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles.css";

import type {
  ThemeMode,
  StartData,
  ProjectCanvasData,
  StreamEvent,
  DraftClarificationAnswer,
  Requirement,
  RequirementClarification,
  ModelSettings,
  ModelTierKey,
  ModelTierSetting,
  StartNodeData,
} from "./types/api";

import {
  fetchStart,
  createProject as apiCreateProject,
  deleteProject as apiDeleteProject,
  getProjectCanvas,
  createRequirement,
  appendRequirementMessage,
  submitRequirementClarifications,
  confirmRequirement,
  getModelSettings,
  saveModelSettings,
  buildClarificationAnswerPayload,
} from "./api/client";

import {
  readError,
  defaultModelSettings,
  readStoredTheme,
  clamp,
  getProjectListHeight,
} from "./utils/format";

import StartNode from "./components/nodes/StartNode";
import {
  PROJECT_LIST_WIDTH,
  PROJECT_ITEM_WIDTH,
  PROJECT_ITEM_HEIGHT,
  PROJECT_ITEM_TOP,
  PROJECT_ITEM_GAP,
  PROJECT_LIST_Y,
  DELETE_CONFIRM_MIN_Y,
  DELETE_CONFIRM_MAX_Y,
  THEME_STORAGE_KEY,
} from "./constants";

const nodeTypes = { startNode: StartNode };

const emptyStartData: StartData = {
  projects: [],
  settings_summary: {
    title: "样式设置",
    description: "暗色主题",
  },
  model_summary: {
    title: "模型设置",
    description: "默认模型待配置",
  },
  model_settings: defaultModelSettings(),
};

function FitViewOnGraphChange({
  nodeCount,
  edgeCount,
}: {
  nodeCount: number;
  edgeCount: number;
}) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.16, duration: 260 });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [edgeCount, fitView, nodeCount]);

  return null;
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [startData, setStartData] = useState<StartData>(emptyStartData);
  const [currentCanvas, setCurrentCanvas] = useState<"start" | "project">(
    "start",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [projectCanvas, setProjectCanvas] = useState<ProjectCanvasData | null>(
    null,
  );
  const [requirementInput, setRequirementInput] = useState("");
  const [requirementBusy, setRequirementBusy] = useState(false);
  const [requirementError, setRequirementError] = useState<string | null>(null);
  const [requirementStreamEvents, setRequirementStreamEvents] = useState<
    StreamEvent[]
  >([]);
  const [clarificationAnswers, setClarificationAnswers] = useState<
    Record<string, DraftClarificationAnswer>
  >({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeleteProject, setPendingDeleteProject] = useState<
    import("./types/api").Project | null
  >(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [models, setModels] = useState<import("./types/api").PiModel[]>([]);
  const [draftModelSettings, setDraftModelSettings] = useState<ModelSettings>(
    defaultModelSettings(),
  );
  const [modelRpcStatus, setModelRpcStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [modelError, setModelError] = useState<string | null>(null);
  const [savingModels, setSavingModels] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const loadStart = useCallback(async () => {
    const data = await fetchStart();
    setStartData(data);
  }, []);

  useEffect(() => {
    loadStart()
      .catch((reason: unknown) => setError(readError(reason)))
      .finally(() => setLoading(false));
  }, [loadStart]);

  const loadProjectCanvas = useCallback(async (projectId: string) => {
    const data = await getProjectCanvas(projectId);
    setProjectCanvas(data);
    return data;
  }, []);

  const openProjectCanvas = useCallback(
    (project: import("./types/api").Project) => {
      setCurrentCanvas("project");
      setSelectedProjectId(project.id);
      setProjectCanvas(null);
      setRequirementInput("");
      setRequirementError(null);
      setRequirementStreamEvents([]);
      setClarificationAnswers({});
      void loadProjectCanvas(project.id).catch((reason) =>
        setRequirementError(readError(reason)),
      );
    },
    [loadProjectCanvas],
  );

  const backToStartCanvas = useCallback(() => {
    setCurrentCanvas("start");
    setSelectedProjectId(null);
    setProjectCanvas(null);
    setRequirementInput("");
    setRequirementError(null);
    setRequirementStreamEvents([]);
    setClarificationAnswers({});
    void loadStart();
  }, [loadStart]);

  const activeRequirementId = projectCanvas?.active_requirement?.id ?? null;

  useEffect(() => {
    setRequirementStreamEvents([]);
    setClarificationAnswers({});
  }, [activeRequirementId]);

  useEffect(() => {
    if (!activeRequirementId || !selectedProjectId) {
      return;
    }

    const source = new EventSource(
      `/api/requirements/${encodeURIComponent(activeRequirementId)}/events`,
    );

    const handleEvent = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as StreamEvent;
        setRequirementStreamEvents((current) => [...current, parsed]);

        const transient =
          parsed.event === "coordinator_started" ||
          parsed.event === "coordinator_progress" ||
          parsed.event === "pi_event";
        if (!transient) {
          void loadProjectCanvas(selectedProjectId).catch((reason) =>
            setRequirementError(readError(reason)),
          );
        }
      } catch {
        // ignore parse errors
      }
    };

    source.onmessage = handleEvent;
    for (const eventName of [
      "coordinator_started",
      "coordinator_progress",
      "pi_event",
      "clarifications_ready",
      "draft_ready",
      "analysis_failed",
    ]) {
      source.addEventListener(eventName, handleEvent);
    }

    return () => source.close();
  }, [activeRequirementId, loadProjectCanvas, selectedProjectId]);

  const loadModelSettings = useCallback(async () => {
    setModelRpcStatus("loading");
    setModelError(null);

    try {
      const data = await getModelSettings();
      setModels(data.models);
      setDraftModelSettings(data.settings);
      setModelRpcStatus(data.rpc_status);
      setModelError(data.rpc_error);
    } catch (reason) {
      setModels([]);
      setModelRpcStatus("error");
      setModelError(readError(reason));
    }
  }, []);

  const toggleModelSettings = useCallback(() => {
    setModelSettingsOpen((open) => {
      if (open) {
        return false;
      }

      void loadModelSettings();
      return true;
    });
  }, [loadModelSettings]);

  const updateModelTier = useCallback(
    (tier: ModelTierKey, setting: ModelTierSetting) => {
      setDraftModelSettings((current) => ({
        ...current,
        [tier]: setting,
      }));
    },
    [],
  );

  const saveModelSettingsCallback = useCallback(async () => {
    setSavingModels(true);
    setModelError(null);

    try {
      const data = await saveModelSettings(draftModelSettings);
      setModels(data.models);
      setDraftModelSettings(data.settings);
      setModelRpcStatus(data.rpc_status);
      setModelError(data.rpc_error);
      await loadStart();
      setModelSettingsOpen(false);
    } catch (reason) {
      setModelError(readError(reason));
    } finally {
      setSavingModels(false);
    }
  }, [draftModelSettings, loadStart]);

  const createProject = useCallback(
    async (name: string, gitUrl: string) => {
      setCreating(true);
      setError(null);

      try {
        await apiCreateProject(name, gitUrl);
        await loadStart();
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setCreating(false);
      }
    },
    [loadStart],
  );

  const requestDeleteProject = useCallback(
    (project: import("./types/api").Project) => {
      setPendingDeleteProject(project);
      setDeleteError(null);
    },
    [],
  );

  const cancelDeleteProject = useCallback(() => {
    setPendingDeleteProject(null);
    setDeleteError(null);
  }, []);

  const confirmDeleteProject = useCallback(
    async (project: import("./types/api").Project) => {
      setDeletingId(project.id);
      setDeleteError(null);

      try {
        await apiDeleteProject(project.id);
        await loadStart();
        setPendingDeleteProject(null);
      } catch (reason) {
        setDeleteError(readError(reason));
      } finally {
        setDeletingId(null);
      }
    },
    [loadStart],
  );

  const sendRequirementMessage = useCallback(async () => {
    const message = requirementInput.trim();
    if (!message || !selectedProjectId) {
      return;
    }

    setRequirementBusy(true);
    setRequirementError(null);
    try {
      const active = projectCanvas?.active_requirement;
      const data = active
        ? await appendRequirementMessage(active.id, message)
        : await createRequirement(selectedProjectId, message);
      setRequirementStreamEvents([]);
      setClarificationAnswers({});
      setProjectCanvas(data);
      setRequirementInput("");
    } catch (reason) {
      setRequirementError(readError(reason));
    } finally {
      setRequirementBusy(false);
    }
  }, [projectCanvas, requirementInput, selectedProjectId]);

  const updateClarificationAnswer = useCallback(
    (
      clarification: RequirementClarification,
      answer: DraftClarificationAnswer,
    ) => {
      setClarificationAnswers((current) => ({
        ...current,
        [clarification.id]: answer,
      }));
    },
    [],
  );

  const submitClarifications = useCallback(
    async (requirement: Requirement) => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const answers = requirement.clarifications.map((clarification) =>
          buildClarificationAnswerPayload(
            clarification,
            clarificationAnswers[clarification.id] ?? {
              selectedOptions: clarification.answer?.selected_options ?? [],
              customText: clarification.answer?.custom_text ?? "",
            },
          ),
        );
        const data = await submitRequirementClarifications(
          requirement.id,
          answers,
        );
        setRequirementStreamEvents([]);
        setClarificationAnswers({});
        setProjectCanvas(data);
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementBusy(false);
      }
    },
    [clarificationAnswers],
  );

  const confirmRequirementCallback = useCallback(
    async (requirement: Requirement) => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const data = await confirmRequirement(requirement.id);
        setProjectCanvas(data);
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementBusy(false);
      }
    },
    [],
  );

  const nodes = useMemo<Node<StartNodeData>[]>(() => {
    if (currentCanvas === "project") {
      const fallbackProject = selectedProjectId
        ? startData.projects.find((project) => project.id === selectedProjectId)
        : null;
      const project = projectCanvas?.project ?? fallbackProject;
      if (!project) {
        return [];
      }

      return [
        {
          id: "project-back",
          type: "startNode",
          position: { x: -260, y: 20 },
          data: {
            kind: "project-back",
            project,
            onBack: backToStartCanvas,
          },
        },
        {
          id: "completed-requirements",
          type: "startNode",
          position: { x: -260, y: 210 },
          data: {
            kind: "requirement-list",
            title: "已完成需求",
            description: `${projectCanvas?.completed_requirements.length ?? 0} 个`,
            requirements: projectCanvas?.completed_requirements ?? [],
            emptyText: "暂无已完成需求",
            tone: "done",
          },
        },
        {
          id: "requirement-chat",
          type: "startNode",
          position: { x: 130, y: 70 },
          data: {
            kind: "requirement-chat",
            project,
            requirement: projectCanvas?.active_requirement ?? null,
            input: requirementInput,
            busy: requirementBusy,
            error: requirementError,
            streamEvents: requirementStreamEvents,
            answers: clarificationAnswers,
            onInputChange: setRequirementInput,
            onSend: sendRequirementMessage,
            onAnswerChange: updateClarificationAnswer,
            onSubmitClarifications: submitClarifications,
            onConfirm: confirmRequirementCallback,
          },
        },
        {
          id: "queued-requirements",
          type: "startNode",
          position: { x: 760, y: 210 },
          data: {
            kind: "requirement-list",
            title: "待执行 / 执行中",
            description: `${projectCanvas?.queued_requirements.length ?? 0} 个`,
            requirements: projectCanvas?.queued_requirements ?? [],
            emptyText: "确认需求后会进入这里",
            tone: "pending",
          },
        },
      ];
    }

    const projectListHeight = getProjectListHeight(startData.projects.length);

    const baseNodes: Node<StartNodeData>[] = [
      {
        id: "style-settings",
        type: "startNode",
        position: { x: 80, y: 80 },
        data: {
          kind: "style-settings",
          theme,
          onThemeChange: setTheme,
        },
      },
      {
        id: "model-settings",
        type: "startNode",
        position: { x: 80, y: 245 },
        data: {
          kind: "summary",
          icon: "model",
          title: startData.model_summary.title,
          description: startData.model_summary.description,
          onAction: toggleModelSettings,
        },
      },
      {
        id: "create-project",
        type: "startNode",
        position: { x: 390, y: 80 },
        data: {
          kind: "create",
          onCreate: createProject,
          busy: creating,
          error,
        },
      },
      {
        id: "project-list",
        type: "startNode",
        position: { x: 390, y: PROJECT_LIST_Y },
        style: {
          width: PROJECT_LIST_WIDTH,
          height: projectListHeight,
        },
        data: {
          kind: "projects",
          projectCount: startData.projects.length,
        },
      },
    ];

    startData.projects.forEach((project, index) => {
      baseNodes.push({
        id: `project-item-${project.id}`,
        type: "startNode",
        parentId: "project-list",
        extent: "parent",
        position: {
          x: 36,
          y:
            PROJECT_ITEM_TOP + index * (PROJECT_ITEM_HEIGHT + PROJECT_ITEM_GAP),
        },
        style: {
          width: PROJECT_ITEM_WIDTH,
          height: PROJECT_ITEM_HEIGHT,
        },
        data: {
          kind: "project-item",
          project,
          deletingId,
          pendingDeleteProjectId: pendingDeleteProject?.id ?? null,
          onOpenProject: openProjectCanvas,
          onDeleteRequest: requestDeleteProject,
        },
      });
    });

    if (pendingDeleteProject) {
      const projectIndex = startData.projects.findIndex(
        (project) => project.id === pendingDeleteProject.id,
      );

      baseNodes.push({
        id: `delete-confirm-${pendingDeleteProject.id}`,
        type: "startNode",
        position: {
          x: 860,
          y: clamp(
            PROJECT_LIST_Y +
              PROJECT_ITEM_TOP +
              Math.max(projectIndex, 0) *
                (PROJECT_ITEM_HEIGHT + PROJECT_ITEM_GAP),
            DELETE_CONFIRM_MIN_Y,
            DELETE_CONFIRM_MAX_Y,
          ),
        },
        data: {
          kind: "delete-confirm",
          project: pendingDeleteProject,
          deleting: deletingId === pendingDeleteProject.id,
          error: deleteError,
          onCancel: cancelDeleteProject,
          onConfirm: confirmDeleteProject,
        },
      });
    }

    if (modelSettingsOpen) {
      baseNodes.push({
        id: "model-config",
        type: "startNode",
        position: { x: -320, y: 80 },
        data: {
          kind: "model-config",
          settings: draftModelSettings,
          models,
          rpcStatus: modelRpcStatus,
          error: modelError,
          saving: savingModels,
          onChange: updateModelTier,
          onClose: () => setModelSettingsOpen(false),
          onSave: saveModelSettingsCallback,
        },
      });
    }

    return baseNodes;
  }, [
    backToStartCanvas,
    cancelDeleteProject,
    confirmDeleteProject,
    confirmRequirementCallback,
    createProject,
    creating,
    currentCanvas,
    deleteError,
    deletingId,
    clarificationAnswers,
    draftModelSettings,
    error,
    modelError,
    modelRpcStatus,
    modelSettingsOpen,
    models,
    pendingDeleteProject,
    projectCanvas,
    openProjectCanvas,
    requestDeleteProject,
    requirementBusy,
    requirementError,
    requirementInput,
    requirementStreamEvents,
    saveModelSettingsCallback,
    selectedProjectId,
    sendRequirementMessage,
    savingModels,
    setModelSettingsOpen,
    startData,
    theme,
    toggleModelSettings,
    submitClarifications,
    updateClarificationAnswer,
    updateModelTier,
  ]);

  const edges = useMemo<Edge[]>(() => {
    if (currentCanvas === "project") {
      return [];
    }

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

    if (pendingDeleteProject) {
      flowEdges.push({
        id: `project-item-delete-confirm-${pendingDeleteProject.id}`,
        source: `project-item-${pendingDeleteProject.id}`,
        sourceHandle: "delete-right",
        target: `delete-confirm-${pendingDeleteProject.id}`,
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

    if (modelSettingsOpen) {
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
  }, [currentCanvas, modelSettingsOpen, pendingDeleteProject]);

  return (
    <main className="app-shell" data-theme={theme}>
      <section className="toolbar">
        <div>
          <h1>Raccoon Node</h1>
          <p>
            {currentCanvas === "project" && projectCanvas
              ? `${projectCanvas.project.name} / 项目画布`
              : "Start 画布"}
          </p>
        </div>
        <div className="status-pill">{loading ? "加载中" : "已连接"}</div>
      </section>
      <section className="canvas-shell">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.16 }}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
          >
            <Background color="rgba(148, 163, 184, 0.18)" gap={24} />
            <Controls position="bottom-right" />
            <FitViewOnGraphChange
              nodeCount={nodes.length}
              edgeCount={edges.length}
            />
          </ReactFlow>
        </ReactFlowProvider>
      </section>
    </main>
  );
}
