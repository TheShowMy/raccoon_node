import { create } from "zustand";

/** 文件工作台 UI 状态（FE-FILE-001：搜索/预览不清空目录展开状态） */
type FilesStore = {
  expandedDirs: Record<string, boolean>;
  selectedPath: string | null;
  /** 输入框草稿 */
  searchText: string;
  /** 已提交的搜索（驱动查询节点与结果节点） */
  submittedQuery: string | null;
  toggleDir: (path: string) => void;
  selectPath: (path: string | null) => void;
  setSearchText: (text: string) => void;
  submitSearch: () => void;
};

export const useFilesStore = create<FilesStore>()((set) => ({
  expandedDirs: {},
  selectedPath: null,
  searchText: "",
  submittedQuery: null,
  toggleDir: (path) =>
    set((state) => ({
      ...state,
      expandedDirs: {
        ...state.expandedDirs,
        [path]: !state.expandedDirs[path],
      },
    })),
  selectPath: (selectedPath) => set((state) => ({ ...state, selectedPath })),
  setSearchText: (searchText) => set((state) => ({ ...state, searchText })),
  submitSearch: () =>
    set((state) => ({
      ...state,
      submittedQuery: state.searchText.trim() ? state.searchText.trim() : null,
    })),
}));
