import { create } from "zustand";

/** 终端工作台 UI 状态：正在重命名的会话 */
type TerminalStore = {
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
};

export const useTerminalStore = create<TerminalStore>()((set) => ({
  renamingId: null,
  setRenamingId: (renamingId) => set((state) => ({ ...state, renamingId })),
}));
