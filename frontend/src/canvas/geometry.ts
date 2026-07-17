/**
 * 主画布射线工作台与相机聚焦几何（FE-CANVAS-009/010/016，纯函数）。
 * 坐标为 React Flow 逻辑坐标；viewport 语义：screen = flow * zoom + translate。
 */

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Viewport = { x: number; y: number; zoom: number };

/** 中心 C → 触发节点中心 N 的单位射线；N ≈ C 时退化为 +X（FE-CANVAS-009） */
export function rayFromCenter(center: Point, nodeCenter: Point): Point {
  const dx = nodeCenter.x - center.x;
  const dy = nodeCenter.y - center.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { x: 1, y: 0 };
  return { x: dx / length, y: dy / length };
}

/** 从矩形中心沿射线到矩形边界的距离 */
export function rectEdgeDistance(
  ray: Point,
  halfWidth: number,
  halfHeight: number,
): number {
  const tx = ray.x === 0 ? Infinity : halfWidth / Math.abs(ray.x);
  const ty = ray.y === 0 ? Infinity : halfHeight / Math.abs(ray.y);
  return Math.min(tx, ty);
}

/**
 * 工作台中心：N + ray * offset，offset = 触发节点边界 + 安全间距 + 工作台半尺寸
 * （FE-CANVAS-009），保证工作台完整落在触发节点外侧。
 */
export function workbenchCenterOnRay(input: {
  canvasCenter: Point;
  triggerCenter: Point;
  triggerSize: Size;
  workbenchSize: Size;
  gap: number;
}): Point {
  const ray = rayFromCenter(input.canvasCenter, input.triggerCenter);
  const triggerEdge = rectEdgeDistance(
    ray,
    input.triggerSize.width / 2,
    input.triggerSize.height / 2,
  );
  const workbenchHalf = rectEdgeDistance(
    ray,
    input.workbenchSize.width / 2,
    input.workbenchSize.height / 2,
  );
  const offset = triggerEdge + input.gap + workbenchHalf;
  return {
    x: input.triggerCenter.x + ray.x * offset,
    y: input.triggerCenter.y + ray.y * offset,
  };
}

/** 相机聚焦：工作台完整可见并带安全边距（FE-CANVAS-010），zoom 限制在 [minZoom, maxZoom] */
export function focusViewport(input: {
  targetCenter: Point;
  targetSize: Size;
  screen: Size;
  padding: number;
  minZoom?: number;
  maxZoom?: number;
}): Viewport {
  const minZoom = input.minZoom ?? 0.2;
  const maxZoom = input.maxZoom ?? 1;
  const usableWidth = Math.max(1, input.screen.width - input.padding * 2);
  const usableHeight = Math.max(1, input.screen.height - input.padding * 2);
  const zoom = Math.min(
    maxZoom,
    Math.max(
      minZoom,
      Math.min(
        usableWidth / input.targetSize.width,
        usableHeight / input.targetSize.height,
      ),
    ),
  );
  return {
    zoom,
    x: input.screen.width / 2 - input.targetCenter.x * zoom,
    y: input.screen.height / 2 - input.targetCenter.y * zoom,
  };
}

/** 有界视差（FE-CANVAS-006）：指针位置 → [-1,1] → 有界相机偏移 */
export function parallaxOffsetForPointer(
  pointer: Point,
  screen: Size,
  maxOffset: number,
): Point {
  const nx = screen.width <= 0 ? 0 : (pointer.x / screen.width - 0.5) * 2;
  const ny = screen.height <= 0 ? 0 : (pointer.y / screen.height - 0.5) * 2;
  const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));
  // +0 归一：避免 -0 影响调用方比较
  return {
    x: -clampUnit(nx) * maxOffset + 0,
    y: -clampUnit(ny) * maxOffset + 0,
  };
}

/** 平滑插值（reduced-motion 时调用方直接设 t=1 稳定相机，FE-CANVAS-016） */
export function lerpPoint(from: Point, to: Point, t: number): Point {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

export function addViewportOffset(viewport: Viewport, offset: Point): Viewport {
  return { ...viewport, x: viewport.x + offset.x, y: viewport.y + offset.y };
}
