import { act, renderHook } from "@testing-library/react";
import type { Node, ReactFlowInstance, Viewport } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  centerFromViewport,
  HOME_NODE_IDS,
  PARALLAX_MAX,
  parallaxTargetForPointer,
  useMainCanvasViewport,
  viewportFor,
} from "./mainCanvasViewport";

describe("useMainCanvasViewport", () => {
  const size = { width: 1280, height: 720 };
  let viewport: Viewport;
  let instance: ReactFlowInstance<Node>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 1),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id),
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));

    viewport = { x: 320, y: 180, zoom: 0.5 };
    const nodes = new Map(
      [...HOME_NODE_IDS, "panel-settings"].map((id) => [
        id,
        { id, position: { x: 0, y: 0 }, data: {} } as Node,
      ]),
    );
    instance = {
      getNode: vi.fn((id: string) => nodes.get(id)),
      getNodesBounds: vi.fn(() => ({ x: 0, y: 0, width: 960, height: 760 })),
      getViewport: vi.fn(() => viewport),
      fitView: vi.fn(async () => true),
      setViewport: vi.fn(async (next: Viewport) => {
        viewport = next;
        return true;
      }),
    } as unknown as ReactFlowInstance<Node>;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount(openPanel: "settings" | null = null) {
    const onFocusComplete = vi.fn();
    const hook = renderHook(
      ({ panel }) =>
        useMainCanvasViewport({ openPanel: panel, onFocusComplete }),
      { initialProps: { panel: openPanel } },
    );
    const container = document.createElement("section");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: size.width,
      bottom: size.height,
      width: size.width,
      height: size.height,
      toJSON: () => ({}),
    });
    hook.result.current.containerRef.current = container;
    act(() => hook.result.current.onInit(instance));
    return { ...hook, container, onFocusComplete };
  }

  it("fits home nodes and follows pointer movement without changing zoom", async () => {
    const hook = mount();
    await act(() => vi.runAllTimersAsync());

    expect(instance.getNodesBounds).toHaveBeenLastCalledWith(
      expect.arrayContaining(
        HOME_NODE_IDS.map((id) => expect.objectContaining({ id })),
      ),
    );
    const base = centerFromViewport(size, viewport);
    const homeZoom = viewport.zoom;

    act(() =>
      hook.result.current.onPointerMove({
        clientX: size.width,
        clientY: size.height / 2,
      } as React.PointerEvent<HTMLElement>),
    );
    await act(() => vi.runAllTimersAsync());

    const shifted = centerFromViewport(size, viewport);
    expect(shifted.x).toBeCloseTo(base.x + PARALLAX_MAX, 0);
    expect(shifted.y).toBeCloseTo(base.y);
    expect(viewport.zoom).toBe(homeZoom);
    hook.unmount();
  });

  it("freezes node interaction, resumes after release, and focuses panels", async () => {
    const hook = mount();
    await act(() => vi.runAllTimersAsync());
    const node = document.createElement("article");
    node.className = "react-flow__node";
    const button = document.createElement("button");
    node.append(button);

    act(() =>
      hook.result.current.onPointerDownCapture({
        target: button,
      } as unknown as React.PointerEvent<HTMLElement>),
    );
    const callsWhileFrozen = vi.mocked(instance.setViewport).mock.calls.length;
    act(() =>
      hook.result.current.onPointerMove({
        clientX: 0,
        clientY: 0,
      } as React.PointerEvent<HTMLElement>),
    );
    await act(() => vi.runAllTimersAsync());
    expect(instance.setViewport).toHaveBeenCalledTimes(callsWhileFrozen);

    act(() => hook.result.current.onPointerUpCapture());
    await act(() => vi.advanceTimersByTimeAsync(121));
    act(() =>
      hook.result.current.onPointerMove({
        clientX: 0,
        clientY: size.height / 2,
      } as React.PointerEvent<HTMLElement>),
    );
    await act(() => vi.runAllTimersAsync());
    expect(vi.mocked(instance.setViewport).mock.calls.length).toBeGreaterThan(
      callsWhileFrozen,
    );

    hook.rerender({ panel: "settings" });
    await act(() => vi.runAllTimersAsync());
    expect(instance.fitView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: [expect.objectContaining({ id: "panel-settings" })],
        maxZoom: 1,
        duration: 175,
      }),
    );
    expect(hook.onFocusComplete).toHaveBeenLastCalledWith("settings");
    hook.unmount();
  });

  it("returns to the latest pointer parallax target after closing a panel", async () => {
    const homeCenter = { x: 480, y: 380 };
    vi.mocked(instance.fitView).mockImplementation(async () => {
      viewport = viewportFor(size, { x: 1900, y: 700 }, 0.5);
      return true;
    });
    const hook = mount();
    await act(() => vi.runAllTimersAsync());

    hook.rerender({ panel: "settings" });
    await act(() => vi.runAllTimersAsync());
    const callsBeforePointerMove = vi.mocked(instance.setViewport).mock.calls
      .length;
    act(() =>
      hook.result.current.onPointerMove({
        clientX: size.width,
        clientY: size.height,
      } as React.PointerEvent<HTMLElement>),
    );
    await act(() => vi.runAllTimersAsync());
    expect(instance.setViewport).toHaveBeenCalledTimes(callsBeforePointerMove);

    hook.rerender({ panel: null });
    await act(() => vi.runAllTimersAsync());
    const expected = parallaxTargetForPointer(
      homeCenter,
      { x: size.width, y: size.height },
      { left: 0, top: 0, width: size.width, height: size.height },
    );
    const actual = centerFromViewport(size, viewport);
    expect(actual.x).toBeCloseTo(expected.x, 0);
    expect(actual.y).toBeCloseTo(expected.y, 0);
    hook.unmount();
  });

  it("does not let pointer movement or release interrupt the home fit", async () => {
    const homeCenter = { x: 480, y: 380 };
    let deferHomeViewport = false;
    let resolveHomeViewport: (() => void) | undefined;
    vi.mocked(instance.fitView).mockImplementation(async () => {
      viewport = viewportFor(size, { x: 1900, y: 700 }, 0.5);
      return true;
    });
    vi.mocked(instance.setViewport).mockImplementation(
      async (next, options) => {
        if (deferHomeViewport && options?.duration === 175) {
          await new Promise<void>((resolve) => {
            resolveHomeViewport = resolve;
          });
        }
        viewport = next;
        return true;
      },
    );
    const hook = mount();
    await act(() => vi.runAllTimersAsync());
    hook.rerender({ panel: "settings" });
    await act(() => vi.runAllTimersAsync());

    act(() =>
      hook.result.current.onPointerMove({
        clientX: size.width,
        clientY: size.height,
      } as React.PointerEvent<HTMLElement>),
    );
    deferHomeViewport = true;
    hook.rerender({ panel: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(resolveHomeViewport).toBeTypeOf("function");
    const callsDuringFit = vi.mocked(instance.setViewport).mock.calls.length;

    act(() =>
      hook.result.current.onPointerMove({
        clientX: size.width - 1,
        clientY: size.height - 1,
      } as React.PointerEvent<HTMLElement>),
    );
    act(() => hook.result.current.onPointerUpCapture());
    await act(() => vi.advanceTimersByTimeAsync(121));
    expect(instance.setViewport).toHaveBeenCalledTimes(callsDuringFit);

    const expected = parallaxTargetForPointer(
      homeCenter,
      { x: size.width, y: size.height },
      { left: 0, top: 0, width: size.width, height: size.height },
    );
    const closingViewport = vi
      .mocked(instance.setViewport)
      .mock.calls.at(-1)?.[0];
    expect(vi.mocked(instance.setViewport).mock.calls.at(-1)?.[1]).toEqual({
      duration: 175,
      interpolate: "linear",
    });
    expect(closingViewport).toBeDefined();
    const directTarget = centerFromViewport(size, closingViewport!);
    expect(directTarget.x).toBeCloseTo(expected.x);
    expect(directTarget.y).toBeCloseTo(expected.y);

    await act(async () => {
      resolveHomeViewport?.();
      await vi.runAllTimersAsync();
    });
    const settled = centerFromViewport(size, viewport);
    expect(settled.x).toBeCloseTo(expected.x, 0);
    expect(settled.y).toBeCloseTo(expected.y, 0);

    act(() =>
      hook.result.current.onPointerMove({
        clientX: size.width - 1,
        clientY: size.height - 1,
      } as React.PointerEvent<HTMLElement>),
    );
    await act(() => vi.runAllTimersAsync());
    const afterSmallMove = centerFromViewport(size, viewport);
    expect(
      Math.hypot(afterSmallMove.x - settled.x, afterSmallMove.y - settled.y),
    ).toBeLessThan(2);
    hook.unmount();
  });

  it("keeps a newer fit locked when an obsolete generation finishes", async () => {
    const hook = mount();
    await act(() => vi.runAllTimersAsync());
    const pendingPanelFits: Array<(value: boolean) => void> = [];
    const pendingHomeViewports: Array<{
      next: Viewport;
      resolve: (value: boolean) => void;
    }> = [];
    vi.mocked(instance.fitView).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          pendingPanelFits.push(resolve);
        }),
    );
    vi.mocked(instance.setViewport).mockImplementation(
      (next) =>
        new Promise<boolean>((resolve) => {
          pendingHomeViewports.push({ next, resolve });
        }),
    );

    hook.rerender({ panel: "settings" });
    await act(() => vi.advanceTimersByTimeAsync(2));
    hook.rerender({ panel: null });
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(pendingPanelFits).toHaveLength(1);
    expect(pendingHomeViewports).toHaveLength(1);

    act(() =>
      hook.result.current.onPointerMove({
        clientX: size.width,
        clientY: size.height,
      } as React.PointerEvent<HTMLElement>),
    );
    const callsWhileBothPending = vi.mocked(instance.setViewport).mock.calls
      .length;
    await act(async () => {
      pendingPanelFits[0]?.(true);
      await Promise.resolve();
    });
    expect(hook.onFocusComplete).not.toHaveBeenCalledWith("settings");
    act(() =>
      hook.result.current.onPointerMove({
        clientX: size.width - 1,
        clientY: size.height - 1,
      } as React.PointerEvent<HTMLElement>),
    );
    expect(instance.setViewport).toHaveBeenCalledTimes(callsWhileBothPending);

    await act(async () => {
      const homeViewport = pendingHomeViewports[0];
      if (homeViewport) {
        viewport = homeViewport.next;
        homeViewport.resolve(true);
      }
      await Promise.resolve();
    });
    expect(hook.onFocusComplete).toHaveBeenLastCalledWith(null);
    act(() =>
      hook.result.current.onPointerMove({
        clientX: 0,
        clientY: 0,
      } as React.PointerEvent<HTMLElement>),
    );
    await act(() => vi.runAllTimersAsync());
    expect(vi.mocked(instance.setViewport).mock.calls.length).toBeGreaterThan(
      callsWhileBothPending,
    );
    hook.unmount();
  });

  it("closes directly to home without parallax when reduced motion is enabled", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const hook = mount();
    await act(() => vi.runAllTimersAsync());
    hook.rerender({ panel: "settings" });
    await act(() => vi.runAllTimersAsync());
    act(() =>
      hook.result.current.onPointerMove({
        clientX: size.width,
        clientY: size.height,
      } as React.PointerEvent<HTMLElement>),
    );

    hook.rerender({ panel: null });
    await act(() => vi.runAllTimersAsync());

    expect(vi.mocked(instance.setViewport).mock.calls.at(-1)?.[1]).toEqual({
      duration: 0,
      interpolate: "linear",
    });
    expect(centerFromViewport(size, viewport)).toEqual({ x: 480, y: 380 });
    hook.unmount();
  });
});
