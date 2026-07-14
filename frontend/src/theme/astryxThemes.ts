import type { DefinedTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { stoneTheme } from "@astryxdesign/theme-stone/built";
import { matchaTheme } from "@astryxdesign/theme-matcha/built";
import { y2kTheme } from "@astryxdesign/theme-y2k/built";
import { chocolateTheme } from "@astryxdesign/theme-chocolate/built";
import { gothicTheme } from "@astryxdesign/theme-gothic/built";
import { butterTheme } from "@astryxdesign/theme-butter/built";
import type { ThemeMode, ThemePack } from "../types/api";

import "@astryxdesign/theme-neutral/theme.css";
import "@astryxdesign/theme-stone/theme.css";
import "@astryxdesign/theme-matcha/theme.css";
import "@astryxdesign/theme-y2k/theme.css";
import "@astryxdesign/theme-chocolate/theme.css";
import "@astryxdesign/theme-gothic/theme.css";
import "@astryxdesign/theme-butter/theme.css";

export const THEME_PACK_OPTIONS: { value: ThemePack; label: string }[] = [
  { value: "neutral", label: "Neutral" },
  { value: "stone", label: "Stone" },
  { value: "matcha", label: "Matcha" },
  { value: "y2k", label: "Y2K" },
  { value: "chocolate", label: "Chocolate" },
  { value: "gothic", label: "Gothic" },
  { value: "butter", label: "Butter" },
];

export const DEFAULT_ASTRYX_THEME = neutralTheme;

export const ASTRYX_THEME_MAP: Record<ThemePack, DefinedTheme> = {
  neutral: neutralTheme,
  stone: stoneTheme,
  matcha: matchaTheme,
  y2k: y2kTheme,
  chocolate: chocolateTheme,
  gothic: gothicTheme,
  butter: butterTheme,
};

export const THEME_CACHE_KEY = "raccoon:theme";

export interface CachedTheme {
  theme_pack: ThemePack;
  theme_mode: ThemeMode;
}

function isThemePack(value: unknown): value is ThemePack {
  return (
    typeof value === "string" &&
    THEME_PACK_OPTIONS.some((option) => option.value === value)
  );
}

export function readCachedTheme(): CachedTheme | null {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "theme_pack" in parsed &&
      "theme_mode" in parsed &&
      isThemePack(parsed.theme_pack) &&
      (parsed.theme_mode === "light" || parsed.theme_mode === "dark")
    ) {
      return {
        theme_pack: parsed.theme_pack,
        theme_mode: parsed.theme_mode,
      };
    }
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return null;
}

export function writeCachedTheme(pack: ThemePack, mode: ThemeMode): void {
  try {
    localStorage.setItem(
      THEME_CACHE_KEY,
      JSON.stringify({ theme_pack: pack, theme_mode: mode }),
    );
  } catch {
    // The current render cycle still applies the selected theme.
  }
}
