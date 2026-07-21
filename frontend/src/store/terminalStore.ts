import { create } from "zustand";

/** 终端工作台 UI 状态：正在重命名的会话 */
type TerminalStore = {
  activeSessionId: string | null;
  renamingId: string | null;
  setActiveSessionId: (id: string | null) => void;
  setRenamingId: (id: string | null) => void;
};

export const useTerminalStore = create<TerminalStore>()((set) => ({
  activeSessionId: null,
  renamingId: null,
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setRenamingId: (renamingId) => set({ renamingId }),
}));
