import { useCallback, useEffect, useState } from "react";
import type { Project, PublicationReadiness, ThemeMode } from "../types/api";
import { getCurrentProject } from "../api/client";
import { readError } from "../utils/format";

export function useCurrentProject() {
  const [project, setProject] = useState<Project | null>(null);
  const [publicationReadiness, setPublicationReadiness] =
    useState<PublicationReadiness | null>(null);
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyTheme = useCallback((nextTheme: ThemeMode) => {
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, []);

  const loadCurrent = useCallback(async () => {
    const current = await getCurrentProject();
    setProject(current.project);
    setPublicationReadiness(current.publication_readiness);
    applyTheme(current.theme);
  }, [applyTheme]);

  useEffect(() => {
    loadCurrent()
      .then(() => setError(null))
      .catch((reason) => setError(readError(reason)))
      .finally(() => setLoading(false));
  }, [loadCurrent]);

  return {
    project,
    publicationReadiness,
    theme,
    loading,
    error,
    setError,
    loadCurrent,
    applyTheme,
  };
}
