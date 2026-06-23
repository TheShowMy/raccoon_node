import type { Node } from "@xyflow/react";
import type {
  ModelSettings,
  PiModel,
  Project,
  StartData,
  StartNodeData,
  ThemeMode,
} from "../types/api";
import {
  PROJECT_LIST_WIDTH,
  PROJECT_ITEM_WIDTH,
  PROJECT_ITEM_HEIGHT,
  PROJECT_ITEM_TOP,
  PROJECT_ITEM_GAP,
  PROJECT_LIST_Y,
  DELETE_CONFIRM_MIN_Y,
  DELETE_CONFIRM_MAX_Y,
} from "../constants";
import { clamp, getProjectListHeight } from "../utils/format";

const DELETE_CONFIRM_NODE_WIDTH = 300;
const DELETE_CONFIRM_NODE_HEIGHT = 360;
const MODEL_CONFIG_NODE_WIDTH = 360;
const MODEL_CONFIG_NODE_HEIGHT = 480;

export interface BuildStartNodesParams {
  startData: StartData;
  theme: ThemeMode;
  creating: boolean;
  error: string | null;
  pendingDeleteProject: Project | null;
  deletingId: string | null;
  deleteError: string | null;
  modelSettingsOpen: boolean;
  draftModelSettings: ModelSettings;
  models: PiModel[];
  modelRpcStatus: "idle" | "loading" | "ready" | "error";
  modelError: string | null;
  savingModels: boolean;
  setTheme: (theme: ThemeMode) => void;
  createProject: (name: string, gitUrl: string) => Promise<void>;
  requestDeleteProject: (project: Project) => void;
  cancelDeleteProject: () => void;
  confirmDeleteProject: (project: Project) => Promise<void>;
  setModelSettingsOpen: (open: boolean) => void;
  toggleModelSettings: () => void;
  updateModelTier: (
    tier: "low" | "medium" | "high",
    setting: {
      model_id: string | null;
      thinking_level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    },
  ) => void;
  saveModelSettings: () => Promise<void>;
  openProjectCanvas: (project: Project) => void;
}

export function buildStartNodes({
  startData,
  theme,
  creating,
  error,
  pendingDeleteProject,
  deletingId,
  deleteError,
  modelSettingsOpen,
  draftModelSettings,
  models,
  modelRpcStatus,
  modelError,
  savingModels,
  setTheme,
  createProject,
  requestDeleteProject,
  cancelDeleteProject,
  confirmDeleteProject,
  setModelSettingsOpen,
  toggleModelSettings,
  updateModelTier,
  saveModelSettings,
  openProjectCanvas,
}: BuildStartNodesParams): Node<StartNodeData>[] {
  const projectListHeight = getProjectListHeight(startData.projects.length);

  const baseNodes: Node<StartNodeData>[] = [
    {
      id: "style-settings",
      type: "startNode",
      position: { x: 80, y: 80 },
      width: 386,
      height: 211,
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
      width: 386,
      height: 141,
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
      width: 386,
      height: 328,
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
      width: PROJECT_LIST_WIDTH,
      height: projectListHeight,
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

  const projectItemNodes = startData.projects.map((project, index) => ({
    id: `project-item-${project.id}`,
    type: "startNode" as const,
    parentId: "project-list",
    extent: "parent" as const,
    width: PROJECT_ITEM_WIDTH,
    height: PROJECT_ITEM_HEIGHT,
    position: {
      x: 36,
      y: PROJECT_ITEM_TOP + index * (PROJECT_ITEM_HEIGHT + PROJECT_ITEM_GAP),
    },
    style: {
      width: PROJECT_ITEM_WIDTH,
      height: PROJECT_ITEM_HEIGHT,
    },
    data: {
      kind: "project-item" as const,
      project,
      deletingId,
      pendingDeleteProjectId: pendingDeleteProject?.id ?? null,
      onOpenProject: openProjectCanvas,
      onDeleteRequest: requestDeleteProject,
    },
  }));

  const deleteConfirmNode: Node<StartNodeData> | null = pendingDeleteProject
    ? (() => {
        const projectIndex = startData.projects.findIndex(
          (project) => project.id === pendingDeleteProject.id,
        );
        return {
          id: `delete-confirm-${pendingDeleteProject.id}`,
          type: "startNode",
          width: DELETE_CONFIRM_NODE_WIDTH,
          height: DELETE_CONFIRM_NODE_HEIGHT,
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
          style: {
            width: DELETE_CONFIRM_NODE_WIDTH,
            height: DELETE_CONFIRM_NODE_HEIGHT,
          },
          data: {
            kind: "delete-confirm",
            project: pendingDeleteProject,
            deleting: deletingId === pendingDeleteProject.id,
            error: deleteError,
            onCancel: cancelDeleteProject,
            onConfirm: confirmDeleteProject,
          },
        };
      })()
    : null;

  const modelConfigNode: Node<StartNodeData> | null = modelSettingsOpen
    ? {
        id: "model-config",
        type: "startNode",
        width: MODEL_CONFIG_NODE_WIDTH,
        height: MODEL_CONFIG_NODE_HEIGHT,
        position: { x: -320, y: 80 },
        style: {
          width: MODEL_CONFIG_NODE_WIDTH,
          height: MODEL_CONFIG_NODE_HEIGHT,
        },
        data: {
          kind: "model-config",
          settings: draftModelSettings,
          models,
          rpcStatus: modelRpcStatus,
          error: modelError,
          saving: savingModels,
          onChange: updateModelTier,
          onClose: () => setModelSettingsOpen(false),
          onSave: saveModelSettings,
        },
      }
    : null;

  return [
    ...baseNodes,
    ...projectItemNodes,
    ...(deleteConfirmNode ? [deleteConfirmNode] : []),
    ...(modelConfigNode ? [modelConfigNode] : []),
  ];
}
