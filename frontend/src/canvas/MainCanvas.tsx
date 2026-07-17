import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useMatch, useNavigate } from "react-router-dom";
import type { WorkbenchKind } from "../api/types";
import { GrayDangoHost } from "../components/pet/GrayDangoHost";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  useCanvasStore,
  type Point,
  type Viewport,
} from "../store/canvasStore";
import {
  addViewportOffset,
  focusViewport,
  lerpPoint,
  parallaxOffsetForPointer,
  workbenchCenterOnRay,
} from "./geometry";
import {
  CAPABILITY_KINDS,
  CENTRAL_NODE_ID,
  computeMainLayout,
  workbenchNodeId,
  workbenchSizeFor,
  type MainLayout,
} from "./layout";
import {
  CanvasWorkbenchNode,
  CapabilityNode,
  CentralConversationNode,
} from "./nodes";
import "./canvas.css";

const nodeTypes = {
  capability: CapabilityNode,
  central: CentralConversationNode,
  workbench: CanvasWorkbenchNode,
};

type CanvasFlowNode = Node<Record<string, unknown>>;

const PARALLAX_MAX_OFFSET = 18;
const WORKBENCH_RAY_GAP = 120;
const CAMERA_PADDING = 48;

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/* ── 有界视差（FE-CANVAS-006/012/016）：只移动外层相机，reduced-motion 关闭 ── */

function useParallax(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const rf = useReactFlow();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const baseRef = useRef<Viewport | null>(null);
  const offsetRef = useRef<Point>({ x: 0, y: 0 });
  const targetRef = useRef<Point>({ x: 0, y: 0 });
  const active = enabled && !reducedMotion;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    baseRef.current = rf.getViewport();
    offsetRef.current = { x: 0, y: 0 };
    targetRef.current = { x: 0, y: 0 };

    const onPointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      targetRef.current = parallaxOffsetForPointer(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        { width: rect.width, height: rect.height },
        PARALLAX_MAX_OFFSET,
      );
    };
    container.addEventListener("pointermove", onPointerMove, { passive: true });

    let raf = 0;
    const tick = () => {
      offsetRef.current = lerpPoint(offsetRef.current, targetRef.current, 0.12);
      if (baseRef.current) {
        rf.setViewport(addViewportOffset(baseRef.current, offsetRef.current));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener("pointermove", onPointerMove);
      // 回稳：直接恢复基准相机（reduced-motion 同样语义）
      if (baseRef.current) rf.setViewport(baseRef.current);
      baseRef.current = null;
    };
  }, [active, rf, containerRef]);

  return {
    /** 打开工作台前读取：基准主 viewport 与当前视差目标（FE-CANVAS-008） */
    snapshot: () => ({
      base: baseRef.current,
      target: targetRef.current,
    }),
  };
}

/* ── 场景 ── */

function MainCanvasScene({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const rf = useReactFlow();
  const navigate = useNavigate();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [size, setSize] = useState(() => ({
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
    height: typeof window === "undefined" ? 900 : window.innerHeight,
  }));

  const mode = useCanvasStore((state) => state.mode);
  const workbench = useCanvasStore((state) => state.workbench);
  const workbenchOpen =
    mode === "opening" || mode === "workbench" || mode === "closing";

  const layout: MainLayout = useMemo(() => computeMainLayout(size), [size]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  const parallax = useParallax(containerRef, mode === "overview");
  const parallaxRef = useRef(parallax);
  parallaxRef.current = parallax;

  const cameraDuration = useCallback(
    () => (reducedMotion ? 0 : 420),
    [reducedMotion],
  );

  /** 打开工作台：保存现场 → 射线外侧生成节点 → 相机聚焦（FE-CANVAS-008～011） */
  const openWorkbenchFlow = useCallback(
    async (kind: WorkbenchKind) => {
      const store = useCanvasStore.getState();
      if (
        store.workbench === kind &&
        (store.mode === "opening" || store.mode === "workbench")
      ) {
        return;
      }
      const currentLayout = layoutRef.current;
      const trigger = currentLayout.capabilities.find((c) => c.kind === kind);
      if (!trigger) return;
      const wbSize = workbenchSizeFor(kind, sizeRef.current);
      const wbCenter = workbenchCenterOnRay({
        canvasCenter: currentLayout.canvasCenter,
        triggerCenter: {
          x: trigger.x + trigger.width / 2,
          y: trigger.y + trigger.height / 2,
        },
        triggerSize: trigger,
        workbenchSize: wbSize,
        gap: WORKBENCH_RAY_GAP,
      });
      const snapshot = parallaxRef.current.snapshot();
      const mainViewport =
        store.savedMainViewport ?? snapshot.base ?? rf.getViewport();
      store.openWorkbench({
        kind,
        workbenchNodeId: workbenchNodeId(kind),
        triggerNodeId: trigger.nodeId,
        restoreFocusId: trigger.nodeId,
        mainViewport,
        parallaxTarget: store.parallaxTarget ?? snapshot.target,
      });
      // 等 React 提交工作台节点与视差回稳后再移动相机，避免动画互相覆盖
      await nextFrame();
      const focus = focusViewport({
        targetCenter: wbCenter,
        targetSize: wbSize,
        screen: sizeRef.current,
        padding: CAMERA_PADDING,
        maxZoom: 1,
      });
      await rf.setViewport(focus, { duration: cameraDuration() });
      useCanvasStore.getState().markWorkbenchReady();
    },
    [rf, cameraDuration],
  );

  /** 关闭工作台：同一 closing 流程精确恢复 viewport 与焦点（FE-CANVAS-014） */
  const closeWorkbenchFlow = useCallback(async () => {
    const store = useCanvasStore.getState();
    if (store.mode !== "workbench" && store.mode !== "opening") return;
    const saved = store.savedMainViewport ?? { x: 0, y: 0, zoom: 1 };
    store.beginCloseWorkbench();
    await rf.setViewport(saved, { duration: cameraDuration() });
    const focusId = useCanvasStore.getState().restoreFocusId;
    useCanvasStore.getState().finishCloseWorkbench();
    if (focusId) {
      requestAnimationFrame(() => {
        containerRef.current
          ?.querySelector<HTMLElement>(`[data-capability-trigger="${focusId}"]`)
          ?.focus();
      });
    }
  }, [rf, cameraDuration, containerRef]);

  const openFlowRef = useRef(openWorkbenchFlow);
  openFlowRef.current = openWorkbenchFlow;
  const closeFlowRef = useRef(closeWorkbenchFlow);
  closeFlowRef.current = closeWorkbenchFlow;

  /* URL ↔ 画布导航状态机（02 §3.3：浏览器前进/后退与节点内开关同一路径） */
  const matchedKind = useMatch("/canvas/workbenches/:kind")?.params.kind as
    WorkbenchKind | undefined;
  // 深链（/delivery/requirements/:id、/delivery/runs/:id）同样打开 delivery 工作台；
  // 内部选中与聚焦由 DeliveryWorkbench 读取参数完成
  const deepKind =
    useMatch("/canvas/workbenches/delivery/requirements/:requirementId") ||
    useMatch("/canvas/workbenches/delivery/runs/:runId")
      ? ("delivery" as const)
      : undefined;
  const effectiveKind = deepKind ?? matchedKind;
  useEffect(() => {
    const store = useCanvasStore.getState();
    if (
      effectiveKind &&
      (CAPABILITY_KINDS as readonly string[]).includes(effectiveKind)
    ) {
      if (store.workbench !== effectiveKind) {
        void openFlowRef.current(effectiveKind);
      }
    } else if (!effectiveKind && store.workbench) {
      void closeFlowRef.current();
    }
  }, [effectiveKind]);

  /* Escape 关闭工作台（FE-CANVAS-014） */
  useEffect(() => {
    if (!workbenchOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        navigate("/");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workbenchOpen, navigate]);

  const nodes = useMemo<CanvasFlowNode[]>(() => {
    const dimmed = workbenchOpen;
    const list: CanvasFlowNode[] = layout.capabilities.map((cap) => ({
      id: cap.nodeId,
      type: "capability",
      position: { x: cap.x, y: cap.y },
      style: { width: cap.width, height: cap.height },
      data: {
        kind: cap.kind,
        dimmed,
        onOpen: (kind: WorkbenchKind) =>
          navigate(`/canvas/workbenches/${kind}`),
      },
      draggable: false,
      selectable: false,
      deletable: false,
    }));
    list.push({
      id: CENTRAL_NODE_ID,
      type: "central",
      position: { x: layout.central.x, y: layout.central.y },
      style: { width: layout.central.width, height: layout.central.height },
      data: { dimmed },
      draggable: false,
      selectable: false,
      deletable: false,
    });
    if (workbenchOpen && workbench) {
      const trigger = layout.capabilities.find((c) => c.kind === workbench);
      if (trigger) {
        const wbSize = workbenchSizeFor(workbench, size);
        const wbCenter = workbenchCenterOnRay({
          canvasCenter: layout.canvasCenter,
          triggerCenter: {
            x: trigger.x + trigger.width / 2,
            y: trigger.y + trigger.height / 2,
          },
          triggerSize: trigger,
          workbenchSize: wbSize,
          gap: WORKBENCH_RAY_GAP,
        });
        list.push({
          id: workbenchNodeId(workbench),
          type: "workbench",
          position: {
            x: wbCenter.x - wbSize.width / 2,
            y: wbCenter.y - wbSize.height / 2,
          },
          style: { width: wbSize.width, height: wbSize.height },
          data: { kind: workbench, onClose: () => navigate("/") },
          draggable: false,
          selectable: false,
          deletable: false,
          zIndex: 20,
        });
      }
    }
    return list;
  }, [layout, size, workbenchOpen, workbench, navigate]);

  return (
    <ReactFlow
      nodes={nodes}
      nodeTypes={nodeTypes}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      onNodeClick={(_event, node) => {
        // XYFlow 行为：节点包装层只有在 selectable/draggable 或 flow 级 onNodeClick
        // 存在时才启用 pointer-events；本 prop 同时承担“打开工作台”路由，
        // 删除它会导致所有外层节点点击穿透到 pane（不可恢复点击）。
        if (node.type === "capability") {
          const kind = (node.data as { kind?: WorkbenchKind }).kind;
          if (kind) navigate(`/canvas/workbenches/${kind}`);
        }
      }}
      panOnDrag={false}
      panOnScroll={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      aria-label="主画布"
    />
  );
}

/** 全屏主画布（02 §3.1 顶层视觉区域之一；GrayDango 为另一区域） */
export function MainCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} className="main-canvas">
      <ReactFlowProvider>
        <MainCanvasScene containerRef={containerRef} />
      </ReactFlowProvider>
      <GrayDangoHost containerRef={containerRef} />
    </div>
  );
}
