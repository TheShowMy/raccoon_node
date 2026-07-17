import { create } from "zustand";
import type { ModelRef, ModelRole } from "../api/types";

/** 模型工作台 UI 状态：角色配置草稿（保存前可编辑，提交成功后与服务端一致） */
type RoleDraft = { primary: ModelRef | null; fallback: ModelRef | null };

type ModelsStore = {
  drafts: Partial<Record<ModelRole, RoleDraft>>;
  credentialInputs: Record<string, string>;
  setDraft: (role: ModelRole, patch: Partial<RoleDraft>) => void;
  clearDraft: (role: ModelRole) => void;
  setCredentialInput: (providerId: string, secret: string) => void;
  clearCredentialInput: (providerId: string) => void;
};

export const useModelsStore = create<ModelsStore>()((set) => ({
  drafts: {},
  credentialInputs: {},
  setDraft: (role, patch) =>
    set((state) => ({
      ...state,
      drafts: {
        ...state.drafts,
        [role]: {
          primary: null,
          fallback: null,
          ...state.drafts[role],
          ...patch,
        },
      },
    })),
  clearDraft: (role) =>
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[role];
      return { ...state, drafts };
    }),
  setCredentialInput: (providerId, secret) =>
    set((state) => ({
      ...state,
      credentialInputs: { ...state.credentialInputs, [providerId]: secret },
    })),
  clearCredentialInput: (providerId) =>
    set((state) => {
      const credentialInputs = { ...state.credentialInputs };
      delete credentialInputs[providerId];
      return { ...state, credentialInputs };
    }),
}));
