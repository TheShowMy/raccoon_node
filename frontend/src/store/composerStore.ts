import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { ImageAttachmentInput } from "../api/client";
import type { IntentMode } from "../api/types";

export type LocalImageAttachment = ImageAttachmentInput & {
  id: string;
  previewUrl: string;
};

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
  /** 图片正文只存在浏览器 File/ObjectURL；发送给 mock 的只有安全元数据。 */
  images: LocalImageAttachment[];
};

export const MAX_FILE_REFS = 8;
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;

export const composerScopeKey = (sessionId: string, branchId: string) =>
  `${sessionId}:${branchId}`;

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
  addImages: (
    branchId: string,
    files: File[],
  ) => { added: number; error: string | null };
  removeImage: (branchId: string, id: string) => void;
};

const revokePreview = (image: LocalImageAttachment) => {
  if (image.previewUrl && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(image.previewUrl);
  }
};

export const useComposerStore: UseBoundStore<StoreApi<ComposerStore>> =
  create<ComposerStore>()((set) => ({
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
        for (const image of drafts[branchId]?.images ?? [])
          revokePreview(image);
        delete drafts[branchId];
        return { drafts };
      }),
    addFileRef: (branchId, path) => {
      const current =
        useComposerStore.getState().drafts[branchId] ?? emptyDraft;
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
    addImages: (branchId, files) => {
      const current =
        useComposerStore.getState().drafts[branchId] ?? emptyDraft;
      const remaining = MAX_IMAGES - current.images.length;
      if (remaining <= 0) return { added: 0, error: "最多添加 3 张图片" };
      const accepted: LocalImageAttachment[] = [];
      let total = current.images.reduce((sum, image) => sum + image.size, 0);
      let error: string | null = null;
      for (const file of files.slice(0, remaining)) {
        if (!file.type.startsWith("image/")) {
          error ??= `${file.name} 不是可识别的图片`;
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          error ??= `${file.name} 超过单张 5 MiB 限制`;
          continue;
        }
        if (total + file.size > MAX_IMAGE_TOTAL_BYTES) {
          error ??= "图片总大小超过 10 MiB 限制";
          continue;
        }
        total += file.size;
        accepted.push({
          id: `${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`,
          name: file.name,
          mime: file.type,
          size: file.size,
          previewUrl:
            typeof URL.createObjectURL === "function"
              ? URL.createObjectURL(file)
              : "",
        });
      }
      if (files.length > remaining) error ??= "最多添加 3 张图片";
      if (accepted.length === 0) return { added: 0, error };
      useComposerStore
        .getState()
        .setDraft(branchId, { images: [...current.images, ...accepted] });
      return { added: accepted.length, error };
    },
    removeImage: (branchId, id) =>
      set((state) => {
        const current = state.drafts[branchId] ?? emptyDraft;
        const removed = current.images.find((image) => image.id === id);
        if (removed) revokePreview(removed);
        return {
          drafts: {
            ...state.drafts,
            [branchId]: {
              ...current,
              images: current.images.filter((image) => image.id !== id),
            },
          },
        };
      }),
  }));
