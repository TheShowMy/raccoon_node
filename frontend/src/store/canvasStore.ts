import { create } from "zustand";
import type { WorkbenchKind } from "../api/types";

/** 02 文档 §4.4：画布导航状态只保存 UI 投影，不复制服务端业务事实 */

export type Point = { x: number; y: number };
export type Viewport = { x: number; y: number; zoom: number };

export type CanvasNavigationState = {
  mode: "overview" | "opening" | "workbench" | "closing";
  workbench: WorkbenchKind | null;
  workbenchNodeId: string | null;
  triggerNodeId: string | null;
  restoreFocusId: string | null;
  savedMainViewport: Viewport | null;
  parallaxTarget: Point | null;
  activeConversationBranchId: string | null;
  selectedConversationNodeId: string | null;
  conversationViewports: Record<string, Viewport>;
  workbenchViewports: Partial<Record<WorkbenchKind, Viewport>>;
  nodeScrollPositions: Record<string, number>;
  expandedProcessGroupIds: string[];
};

export type OpenWorkbenchInput = {
  kind: WorkbenchKind;
  workbenchNodeId: string;
  triggerNodeId: string;
  restoreFocusId: string;
  mainViewport: Viewport;
  parallaxTarget: Point | null;
};

type CanvasActions = {
  /**
   * 打开工作台（FE-CANVAS-008～011）：保存主 viewport/视差目标/触发节点/焦点，
   * 单实例——已打开时先完成当前保存再切换。
   */
  openWorkbench: (input: OpenWorkbenchInput) => void;
  markWorkbenchReady: () => void;
  beginCloseWorkbench: () => void;
  /** 恢复完成后清理瞬时字段，保留对话 viewport 等长期投影 */
  finishCloseWorkbench: () => void;
  saveWorkbenchViewport: (kind: WorkbenchKind, viewport: Viewport) => void;
  setParallaxTarget: (target: Point | null) => void;
  setActiveConversationBranch: (branchId: string) => void;
  setSelectedConversationNode: (nodeId: string | null) => void;
  setConversationViewport: (branchId: string, viewport: Viewport) => void;
  setNodeScrollPosition: (nodeId: string, position: number) => void;
  toggleProcessGroup: (groupId: string) => void;
};

export type CanvasStore = CanvasNavigationState & CanvasActions;

export const initialCanvasNavigationState: CanvasNavigationState = {
  mode: "overview",
  workbench: null,
  workbenchNodeId: null,
  triggerNodeId: null,
  restoreFocusId: null,
  savedMainViewport: null,
  parallaxTarget: null,
  activeConversationBranchId: null,
  selectedConversationNodeId: null,
  conversationViewports: {},
  workbenchViewports: {},
  nodeScrollPositions: {},
  expandedProcessGroupIds: [],
};

export const useCanvasStore = create<CanvasStore>()((set) => ({
  ...initialCanvasNavigationState,

  openWorkbench: (input) =>
    set((state) => {
      // 单实例语义：重复打开同能力视为幂等；打开另一能力直接切换（各自 viewport 已分别保存）
      if (state.mode === "opening" && state.workbench === input.kind) {
        return state;
      }
      const preserving =
        state.mode === "workbench" || state.mode === "opening"
          ? {
              savedMainViewport: state.savedMainViewport ?? input.mainViewport,
              parallaxTarget: state.parallaxTarget ?? input.parallaxTarget,
              restoreFocusId: state.restoreFocusId ?? input.restoreFocusId,
            }
          : {
              savedMainViewport: input.mainViewport,
              parallaxTarget: input.parallaxTarget,
              restoreFocusId: input.restoreFocusId,
            };
      return {
        ...state,
        mode: "opening",
        workbench: input.kind,
        workbenchNodeId: input.workbenchNodeId,
        triggerNodeId: input.triggerNodeId,
        ...preserving,
      };
    }),

  markWorkbenchReady: () =>
    set((state) =>
      state.mode === "opening" ? { ...state, mode: "workbench" } : state,
    ),

  beginCloseWorkbench: () =>
    set((state) =>
      state.mode === "workbench" || state.mode === "opening"
        ? { ...state, mode: "closing" }
        : state,
    ),

  finishCloseWorkbench: () =>
    set((state) => ({
      ...state,
      mode: "overview",
      workbench: null,
      workbenchNodeId: null,
      triggerNodeId: null,
      restoreFocusId: null,
      savedMainViewport: null,
      parallaxTarget: null,
    })),

  saveWorkbenchViewport: (kind, viewport) =>
    set((state) => ({
      ...state,
      workbenchViewports: { ...state.workbenchViewports, [kind]: viewport },
    })),

  setParallaxTarget: (target) =>
    set((state) => ({ ...state, parallaxTarget: target })),

  setActiveConversationBranch: (branchId) =>
    set((state) => ({ ...state, activeConversationBranchId: branchId })),

  setSelectedConversationNode: (nodeId) =>
    set((state) => ({ ...state, selectedConversationNodeId: nodeId })),

  setConversationViewport: (branchId, viewport) =>
    set((state) => ({
      ...state,
      conversationViewports: {
        ...state.conversationViewports,
        [branchId]: viewport,
      },
    })),

  setNodeScrollPosition: (nodeId, position) =>
    set((state) => ({
      ...state,
      nodeScrollPositions: { ...state.nodeScrollPositions, [nodeId]: position },
    })),

  toggleProcessGroup: (groupId) =>
    set((state) => ({
      ...state,
      expandedProcessGroupIds: state.expandedProcessGroupIds.includes(groupId)
        ? state.expandedProcessGroupIds.filter((id) => id !== groupId)
        : [...state.expandedProcessGroupIds, groupId],
    })),
}));
