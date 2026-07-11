export type GrayDangoPosition = { x: number; y: number };
export type GrayDangoDragDirection = "left" | "right";

export const GRAYDANGO_POSITION_STORAGE_KEY =
  "raccoon-node:graydango-position:v1";
export const DEFAULT_GRAYDANGO_POSITION: GrayDangoPosition = { x: 1, y: 1 };
export const GRAYDANGO_DIRECTION_DEADZONE = 2;

type RectSize = { width: number; height: number };
type ContainerRect = RectSize & { left: number; top: number };

export function clampUnitInterval(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function parseGrayDangoPosition(
  stored: string | null,
): GrayDangoPosition {
  if (!stored) return DEFAULT_GRAYDANGO_POSITION;
  try {
    const value = JSON.parse(stored) as Partial<GrayDangoPosition>;
    if (
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y) ||
      value.x < 0 ||
      value.x > 1 ||
      value.y < 0 ||
      value.y > 1
    ) {
      return DEFAULT_GRAYDANGO_POSITION;
    }
    return { x: value.x, y: value.y };
  } catch {
    return DEFAULT_GRAYDANGO_POSITION;
  }
}

export function grayDangoPositionForPointer(
  pointer: { x: number; y: number },
  container: ContainerRect,
  pet: RectSize,
  grabOffset: { x: number; y: number },
): GrayDangoPosition {
  const availableWidth = Math.max(0, container.width - pet.width);
  const availableHeight = Math.max(0, container.height - pet.height);
  const left = pointer.x - container.left - grabOffset.x;
  const top = pointer.y - container.top - grabOffset.y;
  return {
    x: availableWidth ? clampUnitInterval(left / availableWidth) : 0,
    y: availableHeight ? clampUnitInterval(top / availableHeight) : 0,
  };
}

export function grayDangoDragDirection(
  deltaX: number,
  current: GrayDangoDragDirection,
  deadzone = GRAYDANGO_DIRECTION_DEADZONE,
): GrayDangoDragDirection {
  if (Math.abs(deltaX) < deadzone) return current;
  return deltaX < 0 ? "left" : "right";
}
