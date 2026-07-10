import { useCallback, useEffect, useState } from "react";
import type { DefinedTheme } from "@astryxdesign/core/theme";
import type {
  Project,
  PublicationReadiness,
  ThemeMode,
  ThemePack,
} from "../types/api";
import { getCurrentProject } from "../api/client";
import { readError } from "../utils/format";
import { DEFAULT_ASTRYX_THEME, loadAstryxTheme } from "../theme/astryxThemes";

export function useCurrentProject() {
  const [project, setProject] = useState<Project | null>(null);
  const [publicationReadiness, setPublicationReadiness] =
    useState<PublicationReadiness | null>(null);
  const [themePack, setThemePack] = useState<ThemePack>("neutral");
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [theme, setTheme] = useState<DefinedTheme>(DEFAULT_ASTRYX_THEME);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyTheme = useCallback((pack: ThemePack, mode: ThemeMode) => {
    setThemePack(pack);
    setThemeMode(mode);
    void loadAstryxTheme(pack).then(setTheme);
  }, []);

  const loadCurrent = useCallback(async () => {
    const current = await getCurrentProject();
    setProject(current.project);
    setPublicationReadiness(current.publication_readiness);
    applyTheme(current.theme_pack, current.theme_mode);
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
    themePack,
    themeMode,
    loading,
    error,
    setError,
    loadCurrent,
    applyTheme,
  };
}
