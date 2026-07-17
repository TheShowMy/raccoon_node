import { create } from "zustand";

/** Git 工作台 UI 状态：选中的变更（Diff 展示）与表单草稿 */
type GitStore = {
  selectedChangePath: string | null;
  commitMessage: string;
  newBranchName: string;
  selectChange: (path: string | null) => void;
  setCommitMessage: (message: string) => void;
  setNewBranchName: (name: string) => void;
};

export const useGitStore = create<GitStore>()((set) => ({
  selectedChangePath: null,
  commitMessage: "",
  newBranchName: "",
  selectChange: (selectedChangePath) =>
    set((state) => ({ ...state, selectedChangePath })),
  setCommitMessage: (commitMessage) =>
    set((state) => ({ ...state, commitMessage })),
  setNewBranchName: (newBranchName) =>
    set((state) => ({ ...state, newBranchName })),
}));
