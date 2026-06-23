import { describe, expect, it } from "vitest";
import { buildStartNodes } from "./buildStartNodes";
import { DEFAULT_MODEL_SETTINGS } from "../utils/format";
import type { Project, StartData } from "../types/api";

const project: Project = {
  id: "project-1",
  name: "测试项目",
  git_url: "github.com/TheShowMy/raccoon_agents_test.git",
  local_path: "/tmp/project-1",
  created_at: "2026-06-23T09:44:00Z",
  updated_at: "2026-06-23T09:44:00Z",
};

const startData: StartData = {
  projects: [project],
  settings_summary: { title: "样式设置", description: "亮色主题" },
  model_summary: { title: "模型设置", description: "默认模型待配置" },
  model_settings: DEFAULT_MODEL_SETTINGS,
};

function buildNodes() {
  return buildStartNodes({
    startData,
    theme: "light",
    creating: false,
    error: null,
    pendingDeleteProject: project,
    deletingId: null,
    deleteError: null,
    modelSettingsOpen: true,
    draftModelSettings: DEFAULT_MODEL_SETTINGS,
    models: [],
    modelRpcStatus: "idle",
    modelError: null,
    savingModels: false,
    setTheme: () => undefined,
    createProject: async () => undefined,
    requestDeleteProject: () => undefined,
    cancelDeleteProject: () => undefined,
    confirmDeleteProject: async () => undefined,
    setModelSettingsOpen: () => undefined,
    toggleModelSettings: () => undefined,
    updateModelTier: () => undefined,
    saveModelSettings: async () => undefined,
    openProjectCanvas: () => undefined,
  });
}

describe("buildStartNodes", () => {
  it("uses real dimensions for dynamic start nodes", () => {
    const nodes = buildNodes();

    const deleteConfirm = nodes.find(
      (node) => node.id === "delete-confirm-project-1",
    );
    const modelConfig = nodes.find((node) => node.id === "model-config");

    expect(deleteConfirm).toMatchObject({
      width: 300,
      height: 360,
      style: { width: 300, height: 360 },
    });
    expect(modelConfig).toMatchObject({
      width: 360,
      height: 480,
      style: { width: 360, height: 480 },
    });
  });
});
