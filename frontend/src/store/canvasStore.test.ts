import { beforeEach, describe, expect, it } from "vitest";
import {
  initialCanvasNavigationState,
  useCanvasStore,
  type Viewport,
} from "./canvasStore";

const MAIN_VIEWPORT: Viewport = { x: 10, y: 20, zoom: 1 };

function openInput(kind: "git" | "files" | "delivery" = "git") {
  return {
    kind,
    workbenchNodeId: `workbench-${kind}`,
    triggerNodeId: `cap-${kind}`,
    restoreFocusId: `cap-${kind}`,
    mainViewport: MAIN_VIEWPORT,
    parallaxTarget: { x: -4, y: 6 },
  };
}

beforeEach(() => {
  useCanvasStore.setState({ ...initialCanvasNavigationState });
});

describe("CanvasNavigationState（FE-CANVAS-008～015）", () => {
  it("打开工作台保存现场并进入 opening → workbench", () => {
    const store = useCanvasStore.getState();
    store.openWorkbench(openInput("git"));
    let state = useCanvasStore.getState();
    expect(state.mode).toBe("opening");
    expect(state.workbench).toBe("git");
    expect(state.workbenchNodeId).toBe("workbench-git");
    expect(state.triggerNodeId).toBe("cap-git");
    expect(state.savedMainViewport).toEqual(MAIN_VIEWPORT);
    expect(state.parallaxTarget).toEqual({ x: -4, y: 6 });
    useCanvasStore.getState().markWorkbenchReady();
    state = useCanvasStore.getState();
    expect(state.mode).toBe("workbench");
  });

  it("单实例：打开另一能力时保留最初的主 viewport 与返回点", () => {
    useCanvasStore.getState().openWorkbench(openInput("git"));
    useCanvasStore.getState().markWorkbenchReady();
    // 从 git 工作台直接打开 files
    useCanvasStore.getState().openWorkbench({
      ...openInput("files"),
      mainViewport: { x: 999, y: 999, zoom: 2 }, // 聚焦中的相机，不应覆盖原始保存
    });
    const state = useCanvasStore.getState();
    expect(state.workbench).toBe("files");
    expect(state.savedMainViewport).toEqual(MAIN_VIEWPORT);
    expect(state.restoreFocusId).toBe("cap-git");
  });

  it("重复打开同能力幂等，不产生重复状态", () => {
    useCanvasStore.getState().openWorkbench(openInput("git"));
    useCanvasStore.getState().openWorkbench(openInput("git"));
    const state = useCanvasStore.getState();
    expect(state.mode).toBe("opening");
    expect(state.workbench).toBe("git");
  });

  it("关闭流程精确恢复：closing → overview，瞬时字段清理、长期投影保留", () => {
    useCanvasStore.getState().openWorkbench(openInput("git"));
    useCanvasStore.getState().markWorkbenchReady();
    useCanvasStore
      .getState()
      .setConversationViewport("b-main", { x: 1, y: 2, zoom: 0.8 });
    useCanvasStore.getState().saveDeliveryViewport({ x: 3, y: 4, zoom: 0.5 });
    useCanvasStore.getState().toggleProcessGroup("pg:n1");
    useCanvasStore.getState().beginCloseWorkbench();
    expect(useCanvasStore.getState().mode).toBe("closing");
    useCanvasStore.getState().finishCloseWorkbench();
    const state = useCanvasStore.getState();
    expect(state.mode).toBe("overview");
    expect(state.workbench).toBeNull();
    expect(state.workbenchNodeId).toBeNull();
    expect(state.triggerNodeId).toBeNull();
    expect(state.savedMainViewport).toBeNull();
    expect(state.restoreFocusId).toBeNull();
    // 长期投影保留
    expect(state.conversationViewports["b-main"]).toEqual({
      x: 1,
      y: 2,
      zoom: 0.8,
    });
    expect(state.deliveryViewport).toEqual({ x: 3, y: 4, zoom: 0.5 });
    expect(state.expandedProcessGroupIds).toEqual(["pg:n1"]);
  });

  it("ProcessGroup 展开状态可逆切换", () => {
    useCanvasStore.getState().toggleProcessGroup("pg:n1");
    expect(useCanvasStore.getState().expandedProcessGroupIds).toEqual([
      "pg:n1",
    ]);
    useCanvasStore.getState().toggleProcessGroup("pg:n1");
    expect(useCanvasStore.getState().expandedProcessGroupIds).toEqual([]);
  });

  it("不同会话的同名分支分别保存选择、过程组和 viewport", () => {
    const firstScope = "session-1:b-main";
    const secondScope = "session-2:b-main";
    useCanvasStore
      .getState()
      .activateConversationSession("session-1", "b-main");
    useCanvasStore.getState().setSelectedConversationNode("node-1");
    useCanvasStore.getState().toggleProcessGroup("pg:one");
    useCanvasStore
      .getState()
      .setConversationViewport(firstScope, { x: 10, y: 20, zoom: 0.8 });

    useCanvasStore
      .getState()
      .activateConversationSession("session-2", "b-main");
    expect(useCanvasStore.getState().selectedConversationNodeId).toBeNull();
    expect(useCanvasStore.getState().expandedProcessGroupIds).toEqual([]);
    useCanvasStore.getState().setSelectedConversationNode("node-2");
    useCanvasStore.getState().toggleProcessGroup("pg:two");
    useCanvasStore
      .getState()
      .setConversationViewport(secondScope, { x: 30, y: 40, zoom: 1.1 });

    useCanvasStore
      .getState()
      .activateConversationSession("session-1", "b-main");
    const state = useCanvasStore.getState();
    expect(state.selectedConversationNodeId).toBe("node-1");
    expect(state.expandedProcessGroupIds).toEqual(["pg:one"]);
    expect(state.conversationViewports[firstScope]).toEqual({
      x: 10,
      y: 20,
      zoom: 0.8,
    });
    expect(state.conversationViewports[secondScope]).toEqual({
      x: 30,
      y: 40,
      zoom: 1.1,
    });
  });

  it("内部节点定位请求只属于需求工作台并可一次性消费", () => {
    useCanvasStore.getState().requestDeliveryFocus("run:run-1");
    const request = useCanvasStore.getState().deliveryFocusRequest;
    expect(request?.node_id).toBe("run:run-1");
    useCanvasStore.getState().consumeDeliveryFocus(request?.request_id ?? "");
    expect(useCanvasStore.getState().deliveryFocusRequest).toBeNull();
  });
});
