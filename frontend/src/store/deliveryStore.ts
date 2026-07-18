import { create } from "zustand";
import type { RequirementGroupKey } from "../api/groups";

/**
 * 需求交付工作台的本地 UI 状态（02 §9.3、FE-DELIVERY-005）：
 * 选中需求、列表筛选、聚焦请求都是 UI 投影，不是业务事实；
 * 关闭工作台后保留，重新打开时恢复。
 */
export type DeliveryUiState = {
  selectedRequirementId: string | null;
  /** 列表文本搜索 */
  search: string;
  /** 分组筛选；null = 全部 */
  groupFilter: RequirementGroupKey | null;
  /** 一次性聚焦请求（深链 / GrayDango 定位）：子画布节点 id + nonce */
  focusRequest: { nodeId: string; nonce: number } | null;
  /** 诊断是按需辅助节点，不进入任务依赖主链。 */
  diagnosticsRunId: string | null;

  selectRequirement: (requirementId: string | null) => void;
  setSearch: (search: string) => void;
  setGroupFilter: (group: RequirementGroupKey | null) => void;
  requestFocus: (nodeId: string) => void;
  clearFocus: () => void;
  toggleDiagnostics: (runId: string) => void;
};

export const useDeliveryStore = create<DeliveryUiState>()((set) => ({
  selectedRequirementId: null,
  search: "",
  groupFilter: null,
  focusRequest: null,
  diagnosticsRunId: null,

  selectRequirement: (selectedRequirementId) =>
    set((state) => ({ ...state, selectedRequirementId })),
  setSearch: (search) => set((state) => ({ ...state, search })),
  setGroupFilter: (groupFilter) => set((state) => ({ ...state, groupFilter })),
  requestFocus: (nodeId) =>
    set((state) => ({
      ...state,
      focusRequest: { nodeId, nonce: (state.focusRequest?.nonce ?? 0) + 1 },
    })),
  clearFocus: () => set((state) => ({ ...state, focusRequest: null })),
  toggleDiagnostics: (runId) =>
    set((state) => ({
      ...state,
      diagnosticsRunId: state.diagnosticsRunId === runId ? null : runId,
    })),
}));
