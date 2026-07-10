import { describe, expect, it } from "vitest";
import {
  centerFromViewport,
  clampUnit,
  interpolatePoint,
  MAIN_CANVAS_INTERACTION_PROPS,
  PARALLAX_LERP,
  PARALLAX_MAX,
  parallaxTargetForPointer,
  viewportFor,
} from "./mainCanvasViewport";

describe("main canvas viewport", () => {
  const bounds = { left: 100, top: 50, width: 1000, height: 600 };
  const base = { x: 440, y: 424 };

  it("keeps the base center when the pointer is centered", () => {
    expect(parallaxTargetForPointer(base, { x: 600, y: 350 }, bounds)).toEqual(
      base,
    );
  });

  it("maps each viewport corner to the maximum parallax offset", () => {
    expect(parallaxTargetForPointer(base, { x: 100, y: 50 }, bounds)).toEqual({
      x: base.x - PARALLAX_MAX,
      y: base.y - PARALLAX_MAX,
    });
    expect(parallaxTargetForPointer(base, { x: 1100, y: 650 }, bounds)).toEqual(
      { x: base.x + PARALLAX_MAX, y: base.y + PARALLAX_MAX },
    );
  });

  it("clamps pointers outside the canvas", () => {
    expect(clampUnit(-4)).toBe(-1);
    expect(clampUnit(4)).toBe(1);
    expect(
      parallaxTargetForPointer(base, { x: -5000, y: 9000 }, bounds),
    ).toEqual({ x: base.x - PARALLAX_MAX, y: base.y + PARALLAX_MAX });
  });

  it("interpolates toward the target with the verified factor", () => {
    expect(PARALLAX_LERP).toBe(0.16);
    expect(interpolatePoint({ x: 0, y: 100 }, { x: 100, y: 0 })).toEqual({
      x: 16,
      y: 84,
    });
  });

  it("round-trips viewport and center coordinates", () => {
    const size = { width: 1440, height: 900 };
    const viewport = viewportFor(size, base, 0.72);
    const center = centerFromViewport(size, viewport);
    expect(center.x).toBeCloseTo(base.x);
    expect(center.y).toBeCloseTo(base.y);
  });

  it("locks every user-controlled main canvas camera input", () => {
    expect(MAIN_CANVAS_INTERACTION_PROPS).toEqual({
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
    });
  });

  it("keeps orbit nodes interactive while selection stays disabled", () => {
    expect(MAIN_CANVAS_INTERACTION_PROPS.elementsSelectable).toBe(false);
    expect(MAIN_CANVAS_INTERACTION_PROPS.nodesDraggable).toBe(false);
  });
});
