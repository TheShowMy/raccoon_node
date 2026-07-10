import { act, renderHook } from "@testing-library/react";
import type { Node, ReactFlowInstance, Viewport } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  centerFromViewport,
  HOME_NODE_IDS,
  PARALLAX_MAX,
  useMainCanvasViewport,
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

    expect(instance.fitView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining(
          HOME_NODE_IDS.map((id) => expect.objectContaining({ id })),
        ),
        maxZoom: 0.9,
      }),
    );
    const base = centerFromViewport(size, viewport);

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
    expect(viewport.zoom).toBe(0.5);
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
});
