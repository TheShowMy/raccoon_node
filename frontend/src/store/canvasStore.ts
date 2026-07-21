import { create } from "zustand";
import type { WorkbenchKind } from "../api/types";

/** 02 文档 §4.4：画布导航状态只保存 UI 投影，不复制服务端业务事实 */

export type Point = { x: number; y: number };
export type Viewport = { x: number; y: number; zoom: number };

export type DeliveryFocusRequest = {
  node_id: string;
  request_id: string;
};

export type CanvasNavigationState = {
  mode: "overview" | "opening" | "workbench" | "closing";
  workbench: WorkbenchKind | null;
  workbenchNodeId: string | null;
  triggerNodeId: string | null;
  restoreFocusId: string | null;
  savedMainViewport: Viewport | null;
  parallaxTarget: Point | null;
  activeConversationScope: string | null;
  activeConversationBranchId: string | null;
  selectedConversationNodeId: string | null;
  conversationSelections: Record<string, string | null>;
  /** 前向业务操作请求对话图恢复自动跟随；只保存递增信号。 */
  conversationFollowRequestId: number;
  deliveryViewport: Viewport | null;
  scrollPositions: Record<string, number>;
  expandedProcessGroupIds: string[];
  conversationExpandedProcessGroups: Record<string, string[]>;
  /** GrayDango / 深链发出，只由需求子画布一次性消费。 */
  deliveryFocusRequest: DeliveryFocusRequest | null;
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
  /** 恢复完成后清理瞬时字段，保留对话滚动位置等长期投影 */
  finishCloseWorkbench: () => void;
  saveDeliveryViewport: (viewport: Viewport) => void;
  setParallaxTarget: (target: Point | null) => void;
  setActiveConversationBranch: (branchId: string) => void;
  activateConversationSession: (
    sessionId: string,
    rootBranchId: string,
  ) => void;
  setSelectedConversationNode: (nodeId: string | null) => void;
  requestConversationFollow: () => void;
  setScrollPosition: (key: string, position: number) => void;
  toggleProcessGroup: (groupId: string) => void;
  requestDeliveryFocus: (nodeId: string) => void;
  consumeDeliveryFocus: (requestId: string) => void;
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
  activeConversationScope: null,
  activeConversationBranchId: null,
  selectedConversationNodeId: null,
  conversationSelections: {},
  conversationFollowRequestId: 0,
  deliveryViewport: null,
  scrollPositions: {},
  expandedProcessGroupIds: [],
  conversationExpandedProcessGroups: {},
  deliveryFocusRequest: null,
};

let focusRequestSequence = 0;

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
        mode: "opening",
        workbench: input.kind,
        workbenchNodeId: input.workbenchNodeId,
        triggerNodeId: input.triggerNodeId,
        ...preserving,
      };
    }),

  markWorkbenchReady: () =>
    set((state) => (state.mode === "opening" ? { mode: "workbench" } : state)),

  beginCloseWorkbench: () =>
    set((state) =>
      state.mode === "workbench" || state.mode === "opening"
        ? { mode: "closing" }
        : state,
    ),

  finishCloseWorkbench: () =>
    set({
      mode: "overview",
      workbench: null,
      workbenchNodeId: null,
      triggerNodeId: null,
      restoreFocusId: null,
      savedMainViewport: null,
      parallaxTarget: null,
    }),

  saveDeliveryViewport: (viewport) => set({ deliveryViewport: viewport }),

  setParallaxTarget: (target) => set({ parallaxTarget: target }),

  setActiveConversationBranch: (branchId) =>
    set((state) => {
      const sessionId = state.activeConversationScope?.split(":", 1)[0];
      const scope = sessionId ? `${sessionId}:${branchId}` : branchId;
      return {
        activeConversationScope: scope,
        activeConversationBranchId: branchId,
        selectedConversationNodeId: state.conversationSelections[scope] ?? null,
        expandedProcessGroupIds:
          state.conversationExpandedProcessGroups[scope] ?? [],
      };
    }),

  activateConversationSession: (sessionId, rootBranchId) =>
    set((state) => {
      const scope = `${sessionId}:${rootBranchId}`;
      return {
        activeConversationScope: scope,
        activeConversationBranchId: rootBranchId,
        selectedConversationNodeId: state.conversationSelections[scope] ?? null,
        expandedProcessGroupIds:
          state.conversationExpandedProcessGroups[scope] ?? [],
        conversationFollowRequestId: state.conversationFollowRequestId + 1,
      };
    }),

  setSelectedConversationNode: (nodeId) =>
    set((state) => ({
      selectedConversationNodeId: nodeId,
      conversationSelections: state.activeConversationScope
        ? {
            ...state.conversationSelections,
            [state.activeConversationScope]: nodeId,
          }
        : state.conversationSelections,
    })),

  requestConversationFollow: () =>
    set((state) => ({
      conversationFollowRequestId: state.conversationFollowRequestId + 1,
      selectedConversationNodeId: null,
      conversationSelections: state.activeConversationScope
        ? {
            ...state.conversationSelections,
            [state.activeConversationScope]: null,
          }
        : state.conversationSelections,
    })),

  setScrollPosition: (key, position) =>
    set((state) => ({
      scrollPositions: { ...state.scrollPositions, [key]: position },
    })),

  toggleProcessGroup: (groupId) =>
    set((state) => {
      const expandedProcessGroupIds = state.expandedProcessGroupIds.includes(
        groupId,
      )
        ? state.expandedProcessGroupIds.filter((id) => id !== groupId)
        : [...state.expandedProcessGroupIds, groupId];
      return {
        expandedProcessGroupIds,
        conversationExpandedProcessGroups: state.activeConversationScope
          ? {
              ...state.conversationExpandedProcessGroups,
              [state.activeConversationScope]: expandedProcessGroupIds,
            }
          : state.conversationExpandedProcessGroups,
      };
    }),

  requestDeliveryFocus: (node_id) =>
    set(() => ({
      deliveryFocusRequest: {
        node_id,
        request_id: `delivery-focus-${++focusRequestSequence}`,
      },
    })),

  consumeDeliveryFocus: (requestId) =>
    set((state) =>
      state.deliveryFocusRequest?.request_id === requestId
        ? { deliveryFocusRequest: null }
        : state,
    ),
}));
