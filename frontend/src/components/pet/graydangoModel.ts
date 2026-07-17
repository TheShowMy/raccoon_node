export type GrayDangoAnimation =
  "idle" | "waving" | "failed" | "waiting" | "running" | "review";

export type GrayDangoPresentation = {
  animation: GrayDangoAnimation;
  row: number;
  frames: number;
  bubble: string | null;
  tone: "neutral" | "warning" | "error";
};

/** v2：GrayDango 的呈现由通知队列顶部与当前活动驱动（PRD-NOTIFY、FE-PET）。 */
export type GrayDangoQueueTop = {
  severity: "error" | "action_required" | "warning" | "success" | "info";
  message: string;
} | null;

export type GrayDangoActivity =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "responding" }
  | { kind: "tool"; name: string };

export type GrayDangoDirectionCell = { row: 9 | 10; column: number };

export const GRAYDANGO_DRAG_ANIMATIONS = {
  right: { row: 1, frames: 8 },
  left: { row: 2, frames: 8 },
} as const;

const ANIMATIONS: Record<
  GrayDangoAnimation,
  Pick<GrayDangoPresentation, "row" | "frames">
> = {
  idle: { row: 0, frames: 6 },
  waving: { row: 3, frames: 4 },
  failed: { row: 5, frames: 8 },
  waiting: { row: 6, frames: 6 },
  running: { row: 7, frames: 6 },
  review: { row: 8, frames: 6 },
};

function presentation(
  animation: GrayDangoAnimation,
  bubble: string | null,
  tone: GrayDangoPresentation["tone"] = "neutral",
): GrayDangoPresentation {
  return { animation, ...ANIMATIONS[animation], bubble, tone };
}

function compact(value: string, fallback: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 52 ? `${text.slice(0, 52)}…` : text;
}

export function grayDangoDirectionCell(
  deltaX: number,
  deltaY: number,
  deadzone: number,
): GrayDangoDirectionCell | null {
  if (Math.hypot(deltaX, deltaY) <= deadzone) return null;
  const degrees = (Math.atan2(deltaX, -deltaY) * 180) / Math.PI;
  const index = Math.round(((degrees + 360) % 360) / 22.5) % 16;
  return index < 8 ? { row: 9, column: index } : { row: 10, column: index - 8 };
}

export function deriveGrayDangoPresentation(input: {
  top: GrayDangoQueueTop;
  activity: GrayDangoActivity;
}): GrayDangoPresentation {
  const { top, activity } = input;

  if (top?.severity === "error") {
    return presentation("failed", compact(top.message, "遇到问题了"), "error");
  }

  if (activity.kind === "tool") {
    const reviewing = /review|审核|检查|validate|test/i.test(activity.name);
    return presentation(
      reviewing ? "review" : "running",
      compact(activity.name, "正在处理任务"),
    );
  }
  if (activity.kind === "thinking") {
    return presentation("running", "正在思考…");
  }
  if (activity.kind === "responding") {
    return presentation("running", "正在回复…");
  }

  if (!top) return presentation("idle", null);
  switch (top.severity) {
    case "action_required":
      return presentation(
        "waiting",
        compact(top.message, "需要你处理"),
        "warning",
      );
    case "warning":
      return presentation("waiting", compact(top.message, "有警告"), "warning");
    case "success":
      return presentation("waving", compact(top.message, "完成啦"));
    case "info":
      return presentation("idle", compact(top.message, ""));
    default:
      return presentation("idle", null);
  }
}
