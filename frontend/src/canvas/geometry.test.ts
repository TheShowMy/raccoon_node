import { describe, expect, it } from "vitest";
import {
  addViewportOffset,
  focusViewport,
  lerpPoint,
  parallaxOffsetForPointer,
  rayFromCenter,
  rectEdgeDistance,
  workbenchCenterOnRay,
} from "./geometry";

describe("射线几何（FE-CANVAS-009）", () => {
  it("单位射线归一化", () => {
    const ray = rayFromCenter({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(ray.x).toBeCloseTo(0.6);
    expect(ray.y).toBeCloseTo(0.8);
    expect(Math.hypot(ray.x, ray.y)).toBeCloseTo(1);
  });

  it("N ≈ C 时退化为 +X 方向", () => {
    expect(rayFromCenter({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      x: 1,
      y: 0,
    });
  });

  it("矩形边界距离：沿 +X 等于半宽", () => {
    expect(rectEdgeDistance({ x: 1, y: 0 }, 100, 50)).toBe(100);
    expect(rectEdgeDistance({ x: 0, y: 1 }, 100, 50)).toBe(50);
    const diagonal = rectEdgeDistance(
      { x: Math.SQRT1_2, y: Math.SQRT1_2 },
      100,
      50,
    );
    expect(diagonal).toBeCloseTo(50 / Math.SQRT1_2);
  });

  it("工作台中心完整落在触发节点外侧（边界 + 安全间距 + 半尺寸）", () => {
    const center = { x: 720, y: 450 };
    const triggerCenter = { x: 100, y: 450 };
    const triggerSize = { width: 200, height: 128 };
    const wbSize = { width: 680, height: 460 };
    const gap = 120;
    const wbCenter = workbenchCenterOnRay({
      canvasCenter: center,
      triggerCenter,
      triggerSize,
      workbenchSize: wbSize,
      gap,
    });
    // 纯 -X 方向：offset = 100 + 120 + 340 = 560
    expect(wbCenter.y).toBeCloseTo(450);
    expect(triggerCenter.x - wbCenter.x).toBeCloseTo(560);
    // 工作台右缘仍与触发节点左缘保持 gap
    const wbRightEdge = wbCenter.x + wbSize.width / 2;
    const triggerLeftEdge = triggerCenter.x - triggerSize.width / 2;
    expect(triggerLeftEdge - wbRightEdge).toBeCloseTo(gap);
  });
});

describe("相机聚焦（FE-CANVAS-010）", () => {
  it("目标带安全边距完整可见并居中", () => {
    const vp = focusViewport({
      targetCenter: { x: 1000, y: 500 },
      targetSize: { width: 800, height: 600 },
      screen: { width: 1440, height: 900 },
      padding: 48,
    });
    expect(vp.zoom).toBeLessThanOrEqual(1);
    // 目标中心投影到屏幕中心
    expect(1000 * vp.zoom + vp.x).toBeCloseTo(720);
    expect(500 * vp.zoom + vp.y).toBeCloseTo(450);
    // 目标范围不超出屏幕安全区
    const left = (1000 - 400) * vp.zoom + vp.x;
    const right = (1000 + 400) * vp.zoom + vp.x;
    expect(left).toBeGreaterThanOrEqual(48 - 1e-6);
    expect(right).toBeLessThanOrEqual(1440 - 48 + 1e-6);
  });

  it("小目标不超过 maxZoom，超大目标不低于 minZoom", () => {
    const small = focusViewport({
      targetCenter: { x: 0, y: 0 },
      targetSize: { width: 10, height: 10 },
      screen: { width: 1440, height: 900 },
      padding: 48,
    });
    expect(small.zoom).toBe(1);
    const huge = focusViewport({
      targetCenter: { x: 0, y: 0 },
      targetSize: { width: 100000, height: 100000 },
      screen: { width: 1440, height: 900 },
      padding: 48,
      minZoom: 0.2,
    });
    expect(huge.zoom).toBe(0.2);
  });
});

describe("有界视差（FE-CANVAS-006）", () => {
  it("偏移有界且指针到四角时达到上限", () => {
    const screen = { width: 1440, height: 900 };
    const corner = parallaxOffsetForPointer({ x: 1440, y: 900 }, screen, 18);
    expect(corner).toEqual({ x: -18, y: -18 });
    const opposite = parallaxOffsetForPointer({ x: 0, y: 0 }, screen, 18);
    expect(opposite).toEqual({ x: 18, y: 18 });
    const center = parallaxOffsetForPointer({ x: 720, y: 450 }, screen, 18);
    expect(center).toEqual({ x: 0, y: 0 });
  });

  it("屏幕外指针被钳制", () => {
    const screen = { width: 1440, height: 900 };
    const out = parallaxOffsetForPointer({ x: 99999, y: -50 }, screen, 18);
    expect(out).toEqual({ x: -18, y: 18 });
  });

  it("视差叠加可精确回退（viewport 恢复往返）", () => {
    const base = { x: 100, y: 60, zoom: 1 };
    const offset = { x: -12, y: 8 };
    const moved = addViewportOffset(base, offset);
    const restored = addViewportOffset(moved, { x: -offset.x, y: -offset.y });
    expect(restored).toEqual(base);
  });

  it("lerp 插值端点", () => {
    expect(lerpPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0)).toEqual({
      x: 0,
      y: 0,
    });
    expect(lerpPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 1)).toEqual({
      x: 10,
      y: 20,
    });
    expect(lerpPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({
      x: 5,
      y: 10,
    });
  });
});
