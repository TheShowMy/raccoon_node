import { create } from "zustand";

export type SettingsCategory =
  "general" | "models" | "runtime_security" | "maintenance";

type SettingsWorkbenchStore = {
  activeCategory: SettingsCategory;
  setActiveCategory: (category: SettingsCategory) => void;
};

export const useSettingsWorkbenchStore = create<SettingsWorkbenchStore>()(
  (set) => ({
    activeCategory: "general",
    setActiveCategory: (activeCategory) =>
      set((state) => ({ ...state, activeCategory })),
  }),
);
