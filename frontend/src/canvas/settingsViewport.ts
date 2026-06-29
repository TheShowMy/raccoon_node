export type CanvasViewport = { x: number; y: number; zoom: number };
export type CanvasSize = { width: number; height: number };
export type FlowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function getVisibleSettingsViewport(
  viewport: CanvasViewport,
  canvas: CanvasSize,
  target: FlowRect,
  padding: number | { horizontal: number; vertical: number } = 24,
): CanvasViewport {
  const horizontalPadding =
    typeof padding === "number" ? padding : padding.horizontal;
  const verticalPadding =
    typeof padding === "number" ? padding : padding.vertical;
  const x = moveAxis(
    viewport.x,
    viewport.zoom,
    canvas.width,
    target.x,
    target.width,
    horizontalPadding,
  );
  const y = moveAxis(
    viewport.y,
    viewport.zoom,
    canvas.height,
    target.y,
    target.height,
    verticalPadding,
  );

  return x === viewport.x && y === viewport.y
    ? viewport
    : { x, y, zoom: viewport.zoom };
}

function moveAxis(
  offset: number,
  zoom: number,
  canvasSize: number,
  targetPosition: number,
  targetSize: number,
  padding: number,
) {
  const start = targetPosition * zoom + offset;
  const end = (targetPosition + targetSize) * zoom + offset;

  if (end - start > canvasSize - padding * 2) {
    return offset + canvasSize / 2 - (start + end) / 2;
  }
  if (start < padding) return offset + padding - start;
  if (end > canvasSize - padding) {
    return offset + canvasSize - padding - end;
  }
  return offset;
}
