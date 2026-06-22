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
  RequirementConversation,
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
  getRequirementConversation,
  submitRequirementClarifications,
  confirmRequirement,
  planRequirementExecution,
  startRequirementExecution,
  getModelSettings,
  saveModelSettings,
  buildClarificationAnswerPayload,
} from "./api/client";

import {
  readError,
  DEFAULT_MODEL_SETTINGS,
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

function projectIdFromPathname(pathname: string) {
  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function projectCanvasPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}`;
}

function writeBrowserPath(path: string, mode: "push" | "replace") {
  if (window.location.pathname === path) return;
  const method = mode === "push" ? "pushState" : "replaceState";
  window.history[method]({}, "", path);
}

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
  model_settings: DEFAULT_MODEL_SETTINGS,
};

function getTaskLayout(
  tasks: NonNullable<Requirement["execution_plan"]>["tasks"],
) {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const layerCache = new Map<string, number>();

  function resolveLayer(taskId: string, visiting = new Set<string>()): number {
    const cached = layerCache.get(taskId);
    if (cached !== undefined) return cached;
    const task = taskMap.get(taskId);
    if (!task || visiting.has(taskId) || task.depends_on.length === 0) {
      layerCache.set(taskId, 0);
      return 0;
    }

    visiting.add(taskId);
    const layer =
      Math.max(
        ...task.depends_on.map((dependency) =>
          resolveLayer(dependency, new Set(visiting)),
        ),
      ) + 1;
    layerCache.set(taskId, layer);
    return layer;
  }

  const layerRows = new Map<number, number>();
  return new Map(
    tasks.map((task) => {
      const layer = resolveLayer(task.id);
      const row = layerRows.get(layer) ?? 0;
      layerRows.set(layer, row + 1);
      return [
        task.id,
        {
          x: 580 + layer * 310,
          y: 80 + row * 188,
        },
      ];
    }),
  );
}

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
  const initialProjectId = projectIdFromPathname(window.location.pathname);
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [startData, setStartData] = useState<StartData>(emptyStartData);
  const [currentCanvas, setCurrentCanvas] = useState<"start" | "project">(
    initialProjectId ? "project" : "start",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId,
  );
  const [projectCanvas, setProjectCanvas] = useState<ProjectCanvasData | null>(
    null,
  );
  const [selectedDagRequirementId, setSelectedDagRequirementId] = useState<
    string | null
  >(null);
  const [requirementActionBusyId, setRequirementActionBusyId] = useState<
    string | null
  >(null);
  const [requirementInput, setRequirementInput] = useState("");
  const [requirementBusy, setRequirementBusy] = useState(false);
  const [requirementError, setRequirementError] = useState<string | null>(null);
  const [requirementStreamEvents, setRequirementStreamEvents] = useState<
    StreamEvent[]
  >([]);
  const [requirementConversation, setRequirementConversation] =
    useState<RequirementConversation | null>(null);
  const [dismissedPromptRequirementId, setDismissedPromptRequirementId] =
    useState<string | null>(null);
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
    DEFAULT_MODEL_SETTINGS,
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

  const loadRequirementConversation = useCallback(
    async (requirementId: string) => {
      const data = await getRequirementConversation(requirementId);
      setRequirementConversation(data);
      return data;
    },
    [],
  );

  const clearProjectCanvasState = useCallback(() => {
    setProjectCanvas(null);
    setRequirementInput("");
    setRequirementError(null);
    setRequirementStreamEvents([]);
    setRequirementConversation(null);
    setDismissedPromptRequirementId(null);
    setClarificationAnswers({});
    setSelectedDagRequirementId(null);
    setRequirementActionBusyId(null);
  }, []);

  const openProjectCanvas = useCallback(
    (project: import("./types/api").Project) => {
      writeBrowserPath(projectCanvasPath(project.id), "push");
      setCurrentCanvas("project");
      setSelectedProjectId(project.id);
      setError(null);
      clearProjectCanvasState();
    },
    [clearProjectCanvasState],
  );

  const backToStartCanvas = useCallback(() => {
    writeBrowserPath("/", "push");
    setCurrentCanvas("start");
    setSelectedProjectId(null);
    clearProjectCanvasState();
    void loadStart();
  }, [clearProjectCanvasState, loadStart]);

  useEffect(() => {
    if (currentCanvas !== "project" || !selectedProjectId) {
      return;
    }

    let cancelled = false;
    setRequirementError(null);
    void loadProjectCanvas(selectedProjectId)
      .then(() => {
        if (!cancelled) {
          setError(null);
        }
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(readError(reason));
        writeBrowserPath("/", "replace");
        setCurrentCanvas("start");
        setSelectedProjectId(null);
        clearProjectCanvasState();
      });

    return () => {
      cancelled = true;
    };
  }, [
    clearProjectCanvasState,
    currentCanvas,
    loadProjectCanvas,
    selectedProjectId,
  ]);

  useEffect(() => {
    const handlePopState = () => {
      const projectId = projectIdFromPathname(window.location.pathname);
      if (projectId) {
        setCurrentCanvas("project");
        setSelectedProjectId(projectId);
        clearProjectCanvasState();
        return;
      }

      setCurrentCanvas("start");
      setSelectedProjectId(null);
      clearProjectCanvasState();
      void loadStart();
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [clearProjectCanvasState, loadStart]);

  const allProjectRequirements = useMemo(() => {
    const requirements = [
      ...(projectCanvas?.active_requirement
        ? [projectCanvas.active_requirement]
        : []),
      ...(projectCanvas?.queued_requirements ?? []),
      ...(projectCanvas?.completed_requirements ?? []),
    ];
    return requirements.filter(
      (requirement, index, list) =>
        list.findIndex((item) => item.id === requirement.id) === index,
    );
  }, [projectCanvas]);

  const activeRequirementId = projectCanvas?.active_requirement?.id ?? null;
  const selectedDagRequirement =
    allProjectRequirements.find(
      (requirement) => requirement.id === selectedDagRequirementId,
    ) ?? null;
  const observedRequirementId = selectedDagRequirementId ?? activeRequirementId;

  useEffect(() => {
    setRequirementStreamEvents([]);
    setClarificationAnswers({});
    setDismissedPromptRequirementId(null);
    if (activeRequirementId) {
      void loadRequirementConversation(activeRequirementId).catch((reason) =>
        setRequirementError(readError(reason)),
      );
      return;
    }
    setRequirementConversation(null);
  }, [activeRequirementId, loadRequirementConversation]);

  useEffect(() => {
    if (
      selectedDagRequirementId &&
      projectCanvas &&
      !allProjectRequirements.some(
        (requirement) => requirement.id === selectedDagRequirementId,
      )
    ) {
      setSelectedDagRequirementId(null);
    }
  }, [allProjectRequirements, projectCanvas, selectedDagRequirementId]);

  useEffect(() => {
    if (!observedRequirementId || !selectedProjectId) {
      return;
    }

    const source = new EventSource(
      `/api/requirements/${encodeURIComponent(observedRequirementId)}/events`,
    );

    const handleEvent = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as StreamEvent;
        if (parsed.requirement_id === activeRequirementId) {
          setRequirementStreamEvents((current) => [...current, parsed]);
        }

        const transient =
          parsed.event === "coordinator_started" ||
          parsed.event === "coordinator_progress" ||
          parsed.event === "pi_event";
        if (!transient) {
          void Promise.all([
            loadProjectCanvas(selectedProjectId),
            loadRequirementConversation(parsed.requirement_id),
          ]).catch((reason) => setRequirementError(readError(reason)));
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
      "execution_planning_started",
      "execution_plan_ready",
      "execution_plan_failed",
      "execution_started",
      "execution_task_started",
      "execution_task_completed",
      "execution_completed",
      "execution_failed",
    ]) {
      source.addEventListener(eventName, handleEvent);
    }

    return () => source.close();
  }, [
    activeRequirementId,
    loadRequirementConversation,
    loadProjectCanvas,
    observedRequirementId,
    selectedProjectId,
  ]);

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
      setDismissedPromptRequirementId(null);
      setProjectCanvas(data);
      if (data.active_requirement) {
        void loadRequirementConversation(data.active_requirement.id).catch(
          (reason) => setRequirementError(readError(reason)),
        );
      } else {
        setRequirementConversation(null);
      }
      setRequirementInput("");
    } catch (reason) {
      setRequirementError(readError(reason));
    } finally {
      setRequirementBusy(false);
    }
  }, [
    loadRequirementConversation,
    projectCanvas,
    requirementInput,
    selectedProjectId,
  ]);

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
        setDismissedPromptRequirementId(null);
        setProjectCanvas(data);
        if (data.active_requirement) {
          void loadRequirementConversation(data.active_requirement.id).catch(
            (reason) => setRequirementError(readError(reason)),
          );
        }
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementBusy(false);
      }
    },
    [clarificationAnswers, loadRequirementConversation],
  );

  const confirmRequirementCallback = useCallback(
    async (requirement: Requirement) => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const data = await confirmRequirement(requirement.id);
        setDismissedPromptRequirementId(null);
        setProjectCanvas(data);
        if (data.active_requirement) {
          void loadRequirementConversation(data.active_requirement.id).catch(
            (reason) => setRequirementError(readError(reason)),
          );
        } else {
          setRequirementConversation(null);
        }
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementBusy(false);
      }
    },
    [loadRequirementConversation],
  );

  const continueEditingRequirement = useCallback((requirement: Requirement) => {
    setDismissedPromptRequirementId(requirement.id);
  }, []);

  const selectDagRequirement = useCallback((requirement: Requirement) => {
    setSelectedDagRequirementId(requirement.id);
  }, []);

  const closeDag = useCallback(() => {
    setSelectedDagRequirementId(null);
  }, []);

  const planRequirementCallback = useCallback(
    async (requirement: Requirement) => {
      setSelectedDagRequirementId(requirement.id);
      setRequirementActionBusyId(requirement.id);
      setRequirementError(null);
      try {
        const data = await planRequirementExecution(requirement.id);
        setProjectCanvas(data);
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementActionBusyId(null);
      }
    },
    [],
  );

  const startRequirementExecutionCallback = useCallback(
    async (requirement: Requirement) => {
      setSelectedDagRequirementId(requirement.id);
      setRequirementActionBusyId(requirement.id);
      setRequirementError(null);
      try {
        const data = await startRequirementExecution(requirement.id);
        setProjectCanvas(data);
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementActionBusyId(null);
      }
    },
    [],
  );

  const projectNodes = useMemo<Node<StartNodeData>[]>(() => {
    const fallbackProject = selectedProjectId
      ? startData.projects.find((project) => project.id === selectedProjectId)
      : null;
    const project = projectCanvas?.project ?? fallbackProject;
    if (!project) {
      return [];
    }
    const taskLayout = getTaskLayout(
      selectedDagRequirement?.execution_plan?.tasks ?? [],
    );
    const dagFocused = Boolean(selectedDagRequirement);

    return [
      {
        id: "project-back",
        type: "startNode",
        position: dagFocused ? { x: -420, y: 20 } : { x: -328, y: 20 },
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
          onPlanRequirement: planRequirementCallback,
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
                onConfirm: confirmRequirementCallback,
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
          onPlanRequirement: planRequirementCallback,
        },
      },
      ...(selectedDagRequirement
        ? [
            {
              id: "requirement-dag",
              type: "startNode" as const,
              position: { x: 240, y: 140 },
              data: {
                kind: "requirement-dag" as const,
                requirement: selectedDagRequirement,
                busy: requirementActionBusyId === selectedDagRequirement.id,
                onStartExecution: startRequirementExecutionCallback,
                onClose: closeDag,
              },
            },
            ...(selectedDagRequirement.execution_plan?.tasks ?? []).map(
              (task) => ({
                id: `requirement-task-${task.id}`,
                type: "startNode" as const,
                position: taskLayout.get(task.id) ?? { x: 580, y: 80 },
                data: {
                  kind: "requirement-task" as const,
                  task,
                },
              }),
            ),
          ]
        : []),
    ];
  }, [
    backToStartCanvas,
    closeDag,
    confirmRequirementCallback,
    continueEditingRequirement,
    clarificationAnswers,
    dismissedPromptRequirementId,
    planRequirementCallback,
    projectCanvas,
    requirementConversation,
    requirementActionBusyId,
    requirementBusy,
    requirementError,
    requirementInput,
    requirementStreamEvents,
    selectedDagRequirement,
    selectedDagRequirementId,
    selectedProjectId,
    selectDagRequirement,
    sendRequirementMessage,
    startRequirementExecutionCallback,
    startData.projects,
    submitClarifications,
    updateClarificationAnswer,
  ]);

  const startNodes = useMemo<Node<StartNodeData>[]>(() => {
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
    cancelDeleteProject,
    confirmDeleteProject,
    createProject,
    creating,
    deleteError,
    deletingId,
    draftModelSettings,
    error,
    modelError,
    modelRpcStatus,
    modelSettingsOpen,
    models,
    pendingDeleteProject,
    openProjectCanvas,
    requestDeleteProject,
    saveModelSettingsCallback,
    savingModels,
    setModelSettingsOpen,
    startData,
    theme,
    toggleModelSettings,
    updateModelTier,
  ]);

  const nodes = currentCanvas === "project" ? projectNodes : startNodes;

  const projectEdges = useMemo<Edge[]>(() => {
    const flowEdges: Edge[] = selectedDagRequirement
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

    if (selectedDagRequirement) {
      const sourceList =
        selectedDagRequirement.status === "completed"
          ? "completed-requirements"
          : "queued-requirements";
      flowEdges.push({
        id: `${sourceList}-to-requirement-dag`,
        source: sourceList,
        sourceHandle: "requirement-list-right",
        target: "requirement-dag",
        targetHandle: "requirement-dag-left",
        type: "smoothstep",
        animated: true,
        style: {
          stroke: "rgba(249, 115, 22, 0.68)",
          strokeWidth: 2,
        },
      });

      for (const task of selectedDagRequirement.execution_plan?.tasks ?? []) {
        if (task.depends_on.length === 0) {
          flowEdges.push({
            id: `requirement-dag-to-task-${task.id}`,
            source: "requirement-dag",
            sourceHandle: "requirement-dag-right",
            target: `requirement-task-${task.id}`,
            targetHandle: "requirement-task-left",
            type: "smoothstep",
            animated: task.status === "running",
            style: {
              stroke: "rgba(249, 115, 22, 0.64)",
              strokeWidth: 2,
            },
          });
          continue;
        }

        for (const dependency of task.depends_on) {
          flowEdges.push({
            id: `requirement-task-${dependency}-to-${task.id}`,
            source: `requirement-task-${dependency}`,
            sourceHandle: "requirement-task-right",
            target: `requirement-task-${task.id}`,
            targetHandle: "requirement-task-left",
            type: "smoothstep",
            animated: task.status === "running",
            style: {
              stroke: "rgba(20, 184, 166, 0.62)",
              strokeWidth: 2,
            },
          });
        }
      }
    }

    return flowEdges;
  }, [selectedDagRequirement]);

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
  }, [modelSettingsOpen, pendingDeleteProject]);

  const edges = currentCanvas === "project" ? projectEdges : startEdges;

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
