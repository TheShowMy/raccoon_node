import type { DefinedTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";
import type { ThemePack } from "../types/api";

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

export async function loadAstryxTheme(
  themePack: ThemePack,
): Promise<DefinedTheme> {
  switch (themePack) {
    case "neutral":
      await import("@astryxdesign/theme-neutral/theme.css");
      return (await import("@astryxdesign/theme-neutral")).neutralTheme;
    case "stone":
      await import("@astryxdesign/theme-stone/theme.css");
      return (await import("@astryxdesign/theme-stone")).stoneTheme;
    case "matcha":
      await import("@astryxdesign/theme-matcha/theme.css");
      return (await import("@astryxdesign/theme-matcha")).matchaTheme;
    case "y2k":
      await import("@astryxdesign/theme-y2k/theme.css");
      return (await import("@astryxdesign/theme-y2k")).y2kTheme;
    case "chocolate":
      await import("@astryxdesign/theme-chocolate/theme.css");
      return (await import("@astryxdesign/theme-chocolate")).chocolateTheme;
    case "gothic":
      await import("@astryxdesign/theme-gothic/theme.css");
      return (await import("@astryxdesign/theme-gothic")).gothicTheme;
    case "butter":
      await import("@astryxdesign/theme-butter/theme.css");
      return (await import("@astryxdesign/theme-butter")).butterTheme;
  }
}
