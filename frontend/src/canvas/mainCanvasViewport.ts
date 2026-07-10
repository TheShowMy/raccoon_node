import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type {
  Node,
  ReactFlowInstance,
  ReactFlowProps,
  Viewport,
} from "@xyflow/react";
import type { MainPanelKind } from "./orbitNodes";

export const PARALLAX_MAX = 260;
export const PARALLAX_LERP = 0.16;
export const PARALLAX_RELEASE_DELAY = 120;
const PANEL_FOCUS_DURATION = 410;
const PARALLAX_SETTLE_DISTANCE = 0.5;

export const HOME_NODE_IDS = [
  "requirement-chat",
  "orbit-settings",
  "orbit-terminal",
  "orbit-git",
  "orbit-tokens",
  "orbit-requirements",
  "orbit-files",
] as const;

export const MAIN_CANVAS_INTERACTION_PROPS = {
  nodesDraggable: false,
  nodesConnectable: false,
  elementsSelectable: false,
  panOnDrag: false,
  panOnScroll: false,
  zoomOnScroll: false,
  zoomOnPinch: false,
  zoomOnDoubleClick: false,
  selectionOnDrag: false,
  preventScrolling: true,
} satisfies Partial<ReactFlowProps>;

export type Point = { x: number; y: number };
export type CanvasSize = { width: number; height: number };
export type CanvasBounds = CanvasSize & { left: number; top: number };

export function clampUnit(value: number) {
  return Math.max(-1, Math.min(1, value));
}

export function centerFromViewport(
  size: CanvasSize,
  viewport: Viewport,
): Point {
  return {
    x: (size.width / 2 - viewport.x) / viewport.zoom,
    y: (size.height / 2 - viewport.y) / viewport.zoom,
  };
}

export function viewportFor(
  size: CanvasSize,
  center: Point,
  zoom: number,
): Viewport {
  return {
    x: size.width / 2 - center.x * zoom,
    y: size.height / 2 - center.y * zoom,
    zoom,
  };
}

export function parallaxTargetForPointer(
  baseCenter: Point,
  pointer: Point,
  bounds: CanvasBounds,
  maximum = PARALLAX_MAX,
): Point {
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  const normalizedX = (pointer.x - centerX) / Math.max(1, bounds.width / 2);
  const normalizedY = (pointer.y - centerY) / Math.max(1, bounds.height / 2);
  return {
    x: baseCenter.x + clampUnit(normalizedX) * maximum,
    y: baseCenter.y + clampUnit(normalizedY) * maximum,
  };
}

export function interpolatePoint(
  current: Point,
  target: Point,
  amount = PARALLAX_LERP,
): Point {
  return {
    x: current.x + (target.x - current.x) * amount,
    y: current.y + (target.y - current.y) * amount,
  };
}

function prefersReducedMotion() {
  return Boolean(
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
}

function elementSize(element: HTMLElement): CanvasSize {
  const bounds = element.getBoundingClientRect();
  return { width: bounds.width, height: bounds.height };
}

export function useMainCanvasViewport({
  openPanel,
}: {
  openPanel: MainPanelKind | null;
}) {
  const containerRef = useRef<HTMLElement>(null);
  const flowRef = useRef<ReactFlowInstance<Node> | null>(null);
  const openPanelRef = useRef(openPanel);
  const baseCenterRef = useRef<Point>({ x: 0, y: 0 });
  const baseZoomRef = useRef(1);
  const targetRef = useRef<Point>({ x: 0, y: 0 });
  const currentRef = useRef<Point>({ x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const secondFitFrameRef = useRef<number | null>(null);
  const releaseRef = useRef<number | null>(null);
  const fitGenerationRef = useRef(0);
  const initializedRef = useRef(false);
  const frozenRef = useRef(false);

  openPanelRef.current = openPanel;

  const cancelParallax = useCallback(() => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const startParallax = useCallback(() => {
    if (
      frameRef.current !== null ||
      openPanelRef.current ||
      frozenRef.current ||
      prefersReducedMotion()
    ) {
      return;
    }

    const tick = () => {
      frameRef.current = null;
      const flow = flowRef.current;
      const container = containerRef.current;
      if (
        !flow ||
        !container ||
        openPanelRef.current ||
        frozenRef.current ||
        prefersReducedMotion()
      ) {
        return;
      }

      const current = currentRef.current;
      const target = targetRef.current;
      const next = interpolatePoint(current, target);
      currentRef.current = next;
      void flow.setViewport(
        viewportFor(elementSize(container), next, baseZoomRef.current),
        { duration: 0 },
      );

      if (Math.hypot(target.x - next.x, target.y - next.y) > 0.5) {
        frameRef.current = window.requestAnimationFrame(tick);
      }
    };

    frameRef.current = window.requestAnimationFrame(tick);
  }, []);

  const fitCurrentView = useCallback(() => {
    const generation = ++fitGenerationRef.current;
    cancelParallax();
    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current);
    }
    if (secondFitFrameRef.current !== null) {
      window.cancelAnimationFrame(secondFitFrameRef.current);
    }

    fitFrameRef.current = window.requestAnimationFrame(() => {
      secondFitFrameRef.current = window.requestAnimationFrame(async () => {
        fitFrameRef.current = null;
        secondFitFrameRef.current = null;
        const flow = flowRef.current;
        const container = containerRef.current;
        if (!flow || !container || generation !== fitGenerationRef.current) {
          return;
        }

        const panel = openPanelRef.current;
        const ids = panel ? [`panel-${panel}`] : [...HOME_NODE_IDS];
        const nodes = ids.flatMap((id) => {
          const node = flow.getNode(id);
          return node ? [node] : [];
        });
        if (!nodes.length) return;

        const reduced = prefersReducedMotion();
        const animate = initializedRef.current && !reduced;
        await flow.fitView({
          nodes,
          padding: panel ? 0.06 : 0.12,
          maxZoom: panel ? 1 : 0.9,
          duration: animate ? PANEL_FOCUS_DURATION : 0,
        });
        if (generation !== fitGenerationRef.current) return;
        initializedRef.current = true;

        if (!panel) {
          const viewport = flow.getViewport();
          const baseCenter = centerFromViewport(
            elementSize(container),
            viewport,
          );
          baseCenterRef.current = baseCenter;
          baseZoomRef.current = viewport.zoom;
          targetRef.current = baseCenter;
          currentRef.current = baseCenter;
        }
      });
    });
  }, [cancelParallax]);

  const onInit = useCallback(
    (instance: ReactFlowInstance<Node>) => {
      flowRef.current = instance;
      fitCurrentView();
    },
    [fitCurrentView],
  );

  useEffect(() => {
    fitCurrentView();
  }, [fitCurrentView, openPanel]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitCurrentView());
    observer.observe(container);
    return () => observer.disconnect();
  }, [fitCurrentView]);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const container = containerRef.current;
      if (
        !container ||
        !flowRef.current ||
        openPanelRef.current ||
        frozenRef.current ||
        prefersReducedMotion()
      ) {
        return;
      }
      const bounds = container.getBoundingClientRect();
      targetRef.current = parallaxTargetForPointer(
        baseCenterRef.current,
        { x: event.clientX, y: event.clientY },
        bounds,
      );
      startParallax();
    },
    [startParallax],
  );

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!(event.target as Element | null)?.closest(".react-flow__node")) {
        return;
      }
      frozenRef.current = true;
      targetRef.current = currentRef.current;
      cancelParallax();
    },
    [cancelParallax],
  );

  const releaseParallaxSoon = useCallback(() => {
    if (releaseRef.current !== null) {
      window.clearTimeout(releaseRef.current);
    }
    releaseRef.current = window.setTimeout(() => {
      frozenRef.current = false;
      releaseRef.current = null;
      startParallax();
    }, PARALLAX_RELEASE_DELAY);
  }, [startParallax]);

  useEffect(
    () => () => {
      cancelParallax();
      fitGenerationRef.current += 1;
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
      }
      if (secondFitFrameRef.current !== null) {
        window.cancelAnimationFrame(secondFitFrameRef.current);
      }
      if (releaseRef.current !== null) {
        window.clearTimeout(releaseRef.current);
      }
    },
    [cancelParallax],
  );

  return {
    containerRef: containerRef as RefObject<HTMLElement>,
    onInit,
    onPointerMove,
    onPointerDownCapture,
    onPointerUpCapture: releaseParallaxSoon,
    onPointerCancel: releaseParallaxSoon,
  };
}
