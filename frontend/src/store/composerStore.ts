import { create } from "zustand";
import type { IntentMode } from "../api/types";

/**
 * Composer 草稿：按 branch ID 保存的本地 UI 状态（02 §9.3）。
 * 未发送草稿不是业务事实，不进入事件流与 localStorage。
 */
export type ComposerDraft = {
  text: string;
  /** 意图覆盖：auto 为自动判定；覆盖只影响当前提交（FE-CHAT-002） */
  intentOverride: IntentMode;
  /** 仓库文件引用（最多 8 个，PRD-CHAT-001；来自文件工作台"引用到 Composer"） */
  file_refs: string[];
  /** 图片附件占位名（最多 3 张；假数据层接受但不渲染大图） */
  images: string[];
};

export const MAX_FILE_REFS = 8;
export const MAX_IMAGES = 3;

export const emptyDraft: ComposerDraft = {
  text: "",
  intentOverride: "auto",
  file_refs: [],
  images: [],
};

type ComposerStore = {
  drafts: Record<string, ComposerDraft>;
  setDraft: (branchId: string, patch: Partial<ComposerDraft>) => void;
  clearDraft: (branchId: string) => void;
  /** 引用到 Composer（FE-FILE-003）：只加入草稿，不自动发送；超上限返回 false */
  addFileRef: (branchId: string, path: string) => boolean;
  removeFileRef: (branchId: string, path: string) => void;
  addImage: (branchId: string, name: string) => boolean;
  removeImage: (branchId: string, name: string) => void;
};

export const useComposerStore = create<ComposerStore>()((set) => ({
  drafts: {},
  setDraft: (branchId, patch) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [branchId]: { ...(state.drafts[branchId] ?? emptyDraft), ...patch },
      },
    })),
  clearDraft: (branchId) =>
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[branchId];
      return { drafts };
    }),
  addFileRef: (branchId, path) => {
    const current = useComposerStore.getState().drafts[branchId] ?? emptyDraft;
    if (current.file_refs.includes(path)) return true;
    if (current.file_refs.length >= MAX_FILE_REFS) return false;
    useComposerStore
      .getState()
      .setDraft(branchId, { file_refs: [...current.file_refs, path] });
    return true;
  },
  removeFileRef: (branchId, path) =>
    set((state) => {
      const current = state.drafts[branchId] ?? emptyDraft;
      return {
        drafts: {
          ...state.drafts,
          [branchId]: {
            ...current,
            file_refs: current.file_refs.filter((ref) => ref !== path),
          },
        },
      };
    }),
  addImage: (branchId, name) => {
    const current = useComposerStore.getState().drafts[branchId] ?? emptyDraft;
    if (current.images.length >= MAX_IMAGES) return false;
    useComposerStore
      .getState()
      .setDraft(branchId, { images: [...current.images, name] });
    return true;
  },
  removeImage: (branchId, name) =>
    set((state) => {
      const current = state.drafts[branchId] ?? emptyDraft;
      return {
        drafts: {
          ...state.drafts,
          [branchId]: {
            ...current,
            images: current.images.filter((image) => image !== name),
          },
        },
      };
    }),
}));
