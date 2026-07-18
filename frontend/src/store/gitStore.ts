import { create } from "zustand";

/** Git 工作台 UI 状态：选中的变更（Diff 展示）与表单草稿 */
type GitStore = {
  compactPane: "repository" | "changes" | "diff";
  selectedChangePath: string | null;
  commitMessage: string;
  newBranchName: string;
  setCompactPane: (pane: "repository" | "changes" | "diff") => void;
  selectChange: (path: string | null) => void;
  setCommitMessage: (message: string) => void;
  setNewBranchName: (name: string) => void;
};

export const useGitStore = create<GitStore>()((set) => ({
  compactPane: "repository",
  selectedChangePath: null,
  commitMessage: "",
  newBranchName: "",
  setCompactPane: (compactPane) => set((state) => ({ ...state, compactPane })),
  selectChange: (selectedChangePath) =>
    set((state) => ({
      ...state,
      selectedChangePath,
      compactPane: selectedChangePath ? "diff" : state.compactPane,
    })),
  setCommitMessage: (commitMessage) =>
    set((state) => ({ ...state, commitMessage })),
  setNewBranchName: (newBranchName) =>
    set((state) => ({ ...state, newBranchName })),
}));
