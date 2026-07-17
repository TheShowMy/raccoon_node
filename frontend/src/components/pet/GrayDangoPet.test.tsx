import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GrayDangoPet from "./GrayDangoPet";
import type { GrayDangoPresentation } from "./graydangoModel";
import { GRAYDANGO_POSITION_STORAGE_KEY } from "./graydangoPosition";

const IDLE: GrayDangoPresentation = {
  animation: "idle",
  row: 0,
  frames: 6,
  bubble: null,
  tone: "neutral",
};

const BUSY: GrayDangoPresentation = {
  animation: "running",
  row: 7,
  frames: 6,
  bubble: "正在处理…",
  tone: "neutral",
};

function rect(left: number, top: number, width: number, height: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

describe("GrayDangoPet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    class PointerEventMock extends MouseEvent {
      pointerId: number;
      pointerType: string;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "";
      }
    }
    vi.stubGlobal("PointerEvent", PointerEventMock);
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
      clear: vi.fn(() => values.clear()),
      key: vi.fn(() => null),
      get length() {
        return values.size;
      },
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 1),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderPet(presentation: GrayDangoPresentation = IDLE) {
    const containerRef = createRef<HTMLElement>();
    const parentPointerMove = vi.fn();
    render(
      <section ref={containerRef} onPointerMove={parentPointerMove}>
        <GrayDangoPet presentation={presentation} containerRef={containerRef} />
      </section>,
    );
    const pet = screen.getByLabelText("GrayDango 项目助手");
    const sprite = screen.getByRole("img");
    vi.spyOn(containerRef.current!, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 1000, 800),
    );
    vi.spyOn(pet, "getBoundingClientRect").mockReturnValue(
      rect(800, 600, 200, 200),
    );
    Object.defineProperties(sprite, {
      setPointerCapture: { value: vi.fn(), configurable: true },
      hasPointerCapture: {
        value: vi.fn(() => true),
        configurable: true,
      },
      releasePointerCapture: { value: vi.fn(), configurable: true },
    });
    return { containerRef, parentPointerMove, pet, sprite };
  }

  it("drags only from the sprite, plays directional rows, and persists on release", async () => {
    const setItem = vi.mocked(window.localStorage.setItem);
    const { parentPointerMove, pet, sprite } = renderPet();
    setItem.mockClear();

    expect(pet).toHaveStyle({ left: "100%", top: "100%" });
    fireEvent.pointerDown(sprite, {
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientX: 850,
      clientY: 650,
    });
    expect(sprite.setPointerCapture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(sprite, {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 450,
      clientY: 350,
    });
    await act(() => vi.advanceTimersByTimeAsync(2));

    expect(parentPointerMove).toHaveBeenCalled();
    expect(pet).toHaveAttribute("data-animation", "running-left");
    expect(sprite.style.getPropertyValue("--graydango-y")).toContain("-52");
    expect(pet).toHaveStyle({ left: "50%", top: "50%" });
    expect(setItem).not.toHaveBeenCalled();

    fireEvent.pointerUp(sprite, {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 450,
      clientY: 350,
    });
    expect(pet).toHaveAttribute("data-animation", "idle");
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(
      GRAYDANGO_POSITION_STORAGE_KEY,
      JSON.stringify({ x: 0.5, y: 0.5 }),
    );
    expect(sprite.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("switches to the existing right-running row after a clear reversal", async () => {
    const { pet, sprite } = renderPet();
    fireEvent.pointerDown(sprite, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 850,
      clientY: 650,
    });
    fireEvent.pointerMove(sprite, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 700,
      clientY: 650,
    });
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(pet).toHaveAttribute("data-animation", "running-left");

    fireEvent.pointerMove(sprite, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 701,
      clientY: 500,
    });
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(pet).toHaveAttribute("data-animation", "running-left");
    fireEvent.pointerMove(sprite, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 702,
      clientY: 500,
    });
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(pet).toHaveAttribute("data-animation", "running-right");
    expect(sprite.style.getPropertyValue("--graydango-y")).toContain("-26");
    await act(() => vi.advanceTimersByTimeAsync(180));
    expect(sprite.style.getPropertyValue("--graydango-x")).toContain("-24");
    await act(() => vi.advanceTimersByTimeAsync(180 * 7));
    expect(sprite.style.getPropertyValue("--graydango-x")).toContain("0");

    fireEvent.pointerCancel(sprite, {
      pointerId: 8,
      pointerType: "touch",
    });
    expect(pet).toHaveAttribute("data-animation", "idle");
  });

  it("does not start dragging from the status bubble", () => {
    const { pet } = renderPet(BUSY);
    fireEvent.pointerDown(screen.getByText("正在处理…"), {
      pointerId: 10,
      pointerType: "mouse",
      button: 0,
      clientX: 850,
      clientY: 600,
    });
    expect(pet).not.toHaveAttribute("data-dragging");
    expect(pet).toHaveAttribute("data-animation", "running");
  });

  it("uses the directional first frame while reduced motion is enabled", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const { sprite } = renderPet(BUSY);
    fireEvent.pointerDown(sprite, {
      pointerId: 9,
      pointerType: "mouse",
      button: 0,
      clientX: 850,
      clientY: 650,
    });
    fireEvent.pointerMove(sprite, {
      pointerId: 9,
      pointerType: "mouse",
      clientX: 900,
      clientY: 650,
    });
    await act(() => vi.advanceTimersByTimeAsync(400));

    expect(sprite.style.getPropertyValue("--graydango-x")).toContain("0");
    expect(sprite.style.getPropertyValue("--graydango-y")).toContain("-26");
  });
});
