import { create } from "zustand";

/** Git 工作台 UI 状态：选中的变更（Diff 展示）与表单草稿 */
type GitStore = {
  compactPane: "repository" | "changes" | "diff";
  selectedChangePath: string | null;
  selectedChangePaths: string[];
  commitMessage: string;
  newBranchName: string;
  setCompactPane: (pane: "repository" | "changes" | "diff") => void;
  selectChange: (path: string | null) => void;
  toggleChangeSelection: (path: string) => void;
  setGroupSelection: (paths: string[], selected: boolean) => void;
  removeSelectedChanges: (paths: string[]) => void;
  clearChangeSelection: () => void;
  reconcileChangeSelection: (validPaths: string[]) => void;
  setCommitMessage: (message: string) => void;
  setNewBranchName: (name: string) => void;
};

export const useGitStore = create<GitStore>()((set) => ({
  compactPane: "repository",
  selectedChangePath: null,
  selectedChangePaths: [],
  commitMessage: "",
  newBranchName: "",
  setCompactPane: (compactPane) => set({ compactPane }),
  selectChange: (selectedChangePath) =>
    set((state) => ({
      selectedChangePath,
      compactPane: selectedChangePath ? "diff" : state.compactPane,
    })),
  toggleChangeSelection: (path) =>
    set((state) => ({
      selectedChangePaths: state.selectedChangePaths.includes(path)
        ? state.selectedChangePaths.filter((candidate) => candidate !== path)
        : [...state.selectedChangePaths, path],
    })),
  setGroupSelection: (paths, selected) =>
    set((state) => {
      const next = new Set(state.selectedChangePaths);
      for (const path of paths) {
        if (selected) next.add(path);
        else next.delete(path);
      }
      return { selectedChangePaths: [...next] };
    }),
  removeSelectedChanges: (paths) =>
    set((state) => {
      const removed = new Set(paths);
      return {
        selectedChangePaths: state.selectedChangePaths.filter(
          (path) => !removed.has(path),
        ),
      };
    }),
  clearChangeSelection: () => set({ selectedChangePaths: [] }),
  reconcileChangeSelection: (validPaths) =>
    set((state) => {
      const valid = new Set(validPaths);
      return {
        selectedChangePaths: state.selectedChangePaths.filter((path) =>
          valid.has(path),
        ),
      };
    }),
  setCommitMessage: (commitMessage) => set({ commitMessage }),
  setNewBranchName: (newBranchName) => set({ newBranchName }),
}));
