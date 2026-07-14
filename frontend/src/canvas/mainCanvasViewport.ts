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
import { getViewportForBounds } from "@xyflow/react";
import type { MainPanelKind } from "./orbitNodes";

export const PARALLAX_MAX = 260;
export const PARALLAX_LERP = 0.16;
export const PARALLAX_RELEASE_DELAY = 120;
export const PANEL_FOCUS_DURATION = 175;
const HOME_VIEW_PADDING = 0.12;
const HOME_VIEW_MAX_ZOOM = 0.9;
const MAIN_CANVAS_MIN_ZOOM = 0.05;

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
  onFocusComplete,
}: {
  openPanel: MainPanelKind | null;
  onFocusComplete?: (panel: MainPanelKind | null) => void;
}) {
  const containerRef = useRef<HTMLElement>(null);
  const flowRef = useRef<ReactFlowInstance<Node> | null>(null);
  const openPanelRef = useRef(openPanel);
  const onFocusCompleteRef = useRef(onFocusComplete);
  const baseCenterRef = useRef<Point>({ x: 0, y: 0 });
  const baseZoomRef = useRef(1);
  const latestPointerRef = useRef<Point | null>(null);
  const targetRef = useRef<Point>({ x: 0, y: 0 });
  const currentRef = useRef<Point>({ x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const releaseRef = useRef<number | null>(null);
  const fitGenerationRef = useRef(0);
  const fittingGenerationRef = useRef<number | null>(null);
  const initializedRef = useRef(false);
  const frozenRef = useRef(false);

  openPanelRef.current = openPanel;
  onFocusCompleteRef.current = onFocusComplete;

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
      fittingGenerationRef.current !== null ||
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
        fittingGenerationRef.current !== null ||
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
    fittingGenerationRef.current = generation;
    cancelParallax();
    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current);
    }

    fitFrameRef.current = window.requestAnimationFrame(() => {
      void (async () => {
        fitFrameRef.current = null;
        const flow = flowRef.current;
        const container = containerRef.current;
        if (!flow || !container || generation !== fitGenerationRef.current) {
          if (generation === fitGenerationRef.current) {
            fittingGenerationRef.current = null;
          }
          return;
        }

        const panel = openPanelRef.current;
        const ids = panel ? [`panel-${panel}`] : [...HOME_NODE_IDS];
        const nodes = ids.flatMap((id) => {
          const node = flow.getNode(id);
          return node ? [node] : [];
        });
        if (!nodes.length) {
          fittingGenerationRef.current = null;
          return;
        }

        const reduced = prefersReducedMotion();
        const animate = initializedRef.current && !reduced;
        if (panel) {
          await flow.fitView({
            nodes,
            padding: 0.06,
            maxZoom: 1,
            duration: animate ? PANEL_FOCUS_DURATION : 0,
          });
        } else {
          const size = elementSize(container);
          const homeViewport = getViewportForBounds(
            flow.getNodesBounds(nodes),
            size.width,
            size.height,
            MAIN_CANVAS_MIN_ZOOM,
            HOME_VIEW_MAX_ZOOM,
            HOME_VIEW_PADDING,
          );
          const baseCenter = centerFromViewport(size, homeViewport);
          const target =
            !reduced && latestPointerRef.current
              ? parallaxTargetForPointer(
                  baseCenter,
                  latestPointerRef.current,
                  container.getBoundingClientRect(),
                )
              : baseCenter;
          await flow.setViewport(viewportFor(size, target, homeViewport.zoom), {
            duration: animate ? PANEL_FOCUS_DURATION : 0,
            interpolate: "linear",
          });
          if (generation !== fitGenerationRef.current) return;
          baseCenterRef.current = baseCenter;
          baseZoomRef.current = homeViewport.zoom;
          currentRef.current = target;
          targetRef.current = target;
        }
        if (generation !== fitGenerationRef.current) return;
        initializedRef.current = true;
        fittingGenerationRef.current = null;
        onFocusCompleteRef.current?.(panel);
      })();
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
      latestPointerRef.current = { x: event.clientX, y: event.clientY };
      const container = containerRef.current;
      if (
        !container ||
        !flowRef.current ||
        openPanelRef.current ||
        frozenRef.current ||
        fittingGenerationRef.current !== null ||
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
      fittingGenerationRef.current = null;
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
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
