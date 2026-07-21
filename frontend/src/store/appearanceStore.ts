import { create } from "zustand";

/**
 * 本地外观偏好（FE-SET-003）：明暗、密度、GrayDango 动画与非关键气泡。
 * 本地 UI 状态，不是业务事实；关键通知可达性不可关闭。
 */
export type ThemePreference = "system" | "light" | "dark";
export type DensityPreference = "comfortable" | "compact";

type AppearanceStore = {
  theme: ThemePreference;
  density: DensityPreference;
  /** GrayDango 动画（关闭后静态表现） */
  petAnimation: boolean;
  /** 非关键气泡（success/info）；关闭后错误/阻断/待操作/警告仍自动可见 */
  nonCriticalBubbles: boolean;
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: DensityPreference) => void;
  setPetAnimation: (value: boolean) => void;
  setNonCriticalBubbles: (value: boolean) => void;
};

export const useAppearanceStore = create<AppearanceStore>()((set) => ({
  theme: "system",
  density: "comfortable",
  petAnimation: true,
  nonCriticalBubbles: true,
  setTheme: (theme) => set({ theme }),
  setDensity: (density) => set({ density }),
  setPetAnimation: (petAnimation) => set({ petAnimation }),
  setNonCriticalBubbles: (nonCriticalBubbles) => set({ nonCriticalBubbles }),
}));
