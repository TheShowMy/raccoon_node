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
import {
  ASTRYX_THEME_MAP,
  DEFAULT_ASTRYX_THEME,
  readCachedTheme,
  writeCachedTheme,
} from "../theme/astryxThemes";

function resolveInitialTheme(): {
  pack: ThemePack;
  mode: ThemeMode;
  theme: DefinedTheme;
} {
  const cached = readCachedTheme();
  const pack = cached?.theme_pack ?? "neutral";
  const mode = cached?.theme_mode ?? "dark";
  return { pack, mode, theme: ASTRYX_THEME_MAP[pack] ?? DEFAULT_ASTRYX_THEME };
}

export function useCurrentProject() {
  const initial = resolveInitialTheme();
  const [project, setProject] = useState<Project | null>(null);
  const [publicationReadiness, setPublicationReadiness] =
    useState<PublicationReadiness | null>(null);
  const [themePack, setThemePack] = useState<ThemePack>(initial.pack);
  const [themeMode, setThemeMode] = useState<ThemeMode>(initial.mode);
  const [theme, setTheme] = useState<DefinedTheme>(initial.theme);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyTheme = useCallback((pack: ThemePack, mode: ThemeMode) => {
    setThemePack(pack);
    setThemeMode(mode);
    setTheme(ASTRYX_THEME_MAP[pack] ?? DEFAULT_ASTRYX_THEME);
    writeCachedTheme(pack, mode);
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
