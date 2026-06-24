import { useCallback, useEffect, useState } from "react";
import type { Project, StartData, ThemeMode } from "../types/api";
import {
  fetchStart,
  createProject as apiCreateProject,
  deleteProject as apiDeleteProject,
} from "../api/client";
import {
  readError,
  DEFAULT_MODEL_SETTINGS,
  readStoredTheme,
} from "../utils/format";
import { THEME_STORAGE_KEY } from "../constants";

function projectIdFromPathname(pathname: string) {
  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export function projectCanvasPath(projectId: string) {
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

export function useStartData() {
  const initialProjectId = projectIdFromPathname(window.location.pathname);
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [startData, setStartData] = useState<StartData>(emptyStartData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeleteProject, setPendingDeleteProject] =
    useState<Project | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [currentCanvas, setCurrentCanvas] = useState<"start" | "project">(
    initialProjectId ? "project" : "start",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId,
  );

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const loadStart = useCallback(async () => {
    const data = await fetchStart();
    setStartData(data);
  }, []);

  useEffect(() => {
    loadStart()
      .catch((reason) => setError(readError(reason)))
      .finally(() => setLoading(false));
  }, [loadStart]);

  useEffect(() => {
    const handlePopState = () => {
      const projectId = projectIdFromPathname(window.location.pathname);
      if (projectId) {
        setCurrentCanvas("project");
        setSelectedProjectId(projectId);
        return;
      }

      setCurrentCanvas("start");
      setSelectedProjectId(null);
      void loadStart().catch((reason) => setError(readError(reason)));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [loadStart]);

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

  const requestDeleteProject = useCallback((project: Project) => {
    setPendingDeleteProject(project);
    setDeleteError(null);
  }, []);

  const cancelDeleteProject = useCallback(() => {
    setPendingDeleteProject(null);
    setDeleteError(null);
  }, []);

  const confirmDeleteProject = useCallback(
    async (project: Project) => {
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

  const openProjectCanvas = useCallback((project: Project) => {
    writeBrowserPath(projectCanvasPath(project.id), "push");
    setCurrentCanvas("project");
    setSelectedProjectId(project.id);
    setError(null);
  }, []);

  const backToStartCanvas = useCallback(() => {
    writeBrowserPath("/", "push");
    setCurrentCanvas("start");
    setSelectedProjectId(null);
    setError(null);
    void loadStart().catch((reason) => setError(readError(reason)));
  }, [loadStart]);

  return {
    theme,
    setTheme,
    startData,
    loading,
    error,
    setError,
    creating,
    createProject,
    deletingId,
    pendingDeleteProject,
    deleteError,
    requestDeleteProject,
    cancelDeleteProject,
    confirmDeleteProject,
    currentCanvas,
    setCurrentCanvas,
    selectedProjectId,
    setSelectedProjectId,
    openProjectCanvas,
    backToStartCanvas,
    loadStart,
  };
}
