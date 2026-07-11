import type { StartNodeData } from "../../types/api";
import {
  buildLiveActivity,
  conversationEventsToStreamEvents,
} from "../astryx-chat/model";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

export type GrayDangoAnimation =
  | "idle"
  | "waving"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export type GrayDangoPresentation = {
  animation: GrayDangoAnimation;
  row: number;
  frames: number;
  bubble: string | null;
  tone: "neutral" | "warning" | "error";
};

export type GrayDangoDirectionCell = { row: 9 | 10; column: number };

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

export function deriveGrayDangoPresentation(
  data: ChatData,
): GrayDangoPresentation {
  const error = data.error ?? data.projectChatError ?? data.projectChat?.error;
  if (error) {
    return presentation("failed", compact(error, "遇到问题了"), "error");
  }

  const requirementActivity = buildLiveActivity(data.streamEvents);
  const projectActivity = buildLiveActivity(
    conversationEventsToStreamEvents(data.projectChatEvents),
  );
  const requirementRunning = Boolean(
    data.busy ||
    data.conversation?.running ||
    data.requirementOpeningId ||
    data.requirement?.status === "analyzing" ||
    data.requirement?.status === "planning" ||
    data.requirement?.status === "running",
  );
  const projectRunning = Boolean(
    data.projectChatBusy || data.projectChat?.running,
  );
  const activity = requirementRunning ? requirementActivity : projectActivity;
  const activeTool = [...activity.tools]
    .reverse()
    .find((tool) => tool.status === "running" || tool.status === "pending");

  if (activeTool) {
    const reviewing = /review|审核|检查|validate|test/i.test(activeTool.name);
    return presentation(
      reviewing ? "review" : "running",
      compact(activeTool.name, "正在处理任务"),
    );
  }
  if (requirementRunning || projectRunning) {
    if (activity.thinking.trim()) {
      return presentation("running", "正在思考…");
    }
    if (activity.output.trim()) {
      return presentation("running", "正在回复…");
    }
    return presentation("running", "正在处理…");
  }

  switch (data.requirement?.status) {
    case "clarifying":
      return presentation("waiting", "需要你补充信息", "warning");
    case "draft_ready":
      return presentation("waiting", "草案准备好了，等你确认", "warning");
    case "plan_ready":
      return presentation("waiting", "执行计划准备好了", "warning");
    case "queued":
      return presentation("waiting", "已加入执行队列", "warning");
    case "completed":
      return presentation("waving", "任务完成啦");
    case "failed":
      return presentation("failed", "任务执行失败", "error");
    default:
      return presentation("idle", null);
  }
}
