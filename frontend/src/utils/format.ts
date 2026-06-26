import {
  type ClarificationQuestionType,
  type RequirementClarification,
  type DraftClarificationAnswer,
  type RequirementStatus,
  type RequirementMessage,
  type LiveBubble,
  type TraceData,
  type TraceMetadata,
  type StreamEvent,
  type ProjectChatEvent,
  type ModelSettings,
  type ThemeMode,
  type ModelTierKey,
  type ModelTierSetting,
  type ThinkingLevel,
} from "../types/api";

export const tierLabels: Record<ModelTierKey, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export const thinkingLevels: Array<{ value: ThinkingLevel; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function readError(reason: unknown) {
  return reason instanceof Error ? reason.message : "未知错误";
}

export function shortenGitUrl(value: string) {
  return value.replace(/^git@([^:]+):/, "$1/").replace(/^https?:\/\//, "");
}

export function githubUrlFromGitUrl(value: string) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      value.trim(),
    );
  return match ? `https://github.com/${match[1]}` : null;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  low: { model_id: null, thinking_level: "low" },
  medium: { model_id: null, thinking_level: "medium" },
  high: { model_id: null, thinking_level: "high" },
};

export function modelStatusText(
  status: "idle" | "loading" | "ready" | "reconnecting" | "error",
) {
  if (status === "loading") {
    return "正在读取 Pi Agent 模型";
  }
  if (status === "ready") {
    return "Pi Agent RPC 已连接";
  }
  if (status === "error") {
    return "Pi Agent RPC 异常";
  }
  if (status === "reconnecting") {
    return "Pi Agent 重新连接中...";
  }
  return "等待加载";
}

export function requirementStatusText(status: RequirementStatus) {
  const labels: Record<RequirementStatus, string> = {
    analyzing: "分析中",
    clarifying: "澄清中",
    draft_ready: "待确认",
    planning: "拆分任务中",
    plan_ready: "待执行",
    queued: "等待执行",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
  };
  return labels[status];
}

export function requirementMessageRoleText(role: RequirementMessage["role"]) {
  if (role === "user") {
    return "你";
  }
  if (role === "assistant") {
    return "Coordinator";
  }
  if (role === "trace") {
    return "过程";
  }
  return "系统";
}

export function traceStatusText(status: LiveBubble["status"]) {
  if (status === "running") return "进行中";
  if (status === "error") return "失败";
  return "完成";
}

export function traceFromMessage(
  message: RequirementMessage,
): TraceData | null {
  if (message.role !== "trace" || message.metadata?.type !== "pi_trace") {
    return null;
  }
  return message.metadata.trace;
}

export function traceFromMetadata(
  metadata: TraceMetadata | null | undefined,
): TraceData | null {
  return metadata?.type === "pi_trace" ? metadata.trace : null;
}

export function buildBubbleStreamFromTrace(trace: TraceData): LiveBubble[] {
  const bubbles: LiveBubble[] = [];
  let seq = 0;

  for (const status of trace.statuses ?? []) {
    bubbles.push({
      id: `status-${seq++}`,
      type: "status",
      label: status.message,
      content: "",
      status: "done",
    });
  }

  if (trace.thinking?.trim()) {
    bubbles.push({
      id: `thinking-${seq++}`,
      type: "thinking",
      label: "思考过程",
      content: trace.thinking,
      status: "done",
    });
  }

  for (const tool of trace.tools ?? []) {
    bubbles.push({
      id: tool.toolCallId,
      type: "tool",
      label: tool.toolName,
      content: tool.output,
      toolName: tool.toolName,
      status: tool.isError || tool.status === "error" ? "error" : "done",
    });
  }

  return bubbles;
}

type PiStreamEvent = StreamEvent | ProjectChatEvent;

export function buildBubbleStreamFromEvents(
  events: PiStreamEvent[],
): LiveBubble[] {
  const bubbles: LiveBubble[] = [];
  let seq = 0;

  for (const event of events) {
    if (event.event !== "pi_event") continue;
    const payload = asRecord(event.payload);

    if (event.pi_type === "message_update") {
      const assistantEvent = asRecord(payload?.assistantMessageEvent);
      const deltaType = String(assistantEvent?.type ?? "");
      const delta = String(assistantEvent?.delta ?? assistantEvent?.text ?? "");
      if (!delta) continue;
      if (deltaType !== "thinking_delta") continue;

      const last = bubbles.at(-1);
      if (last?.type === "thinking") {
        bubbles[bubbles.length - 1] = {
          ...last,
          content: last.content + delta,
        };
      } else {
        bubbles.push({
          id: `thinking-${seq++}`,
          type: "thinking",
          label: "思考中...",
          content: delta,
          status: "running",
        });
      }
      continue;
    }

    if (event.pi_type === "tool_execution_start") {
      const toolCallId = String(
        payload?.toolCallId ?? payload?.tool_call_id ?? `tool-${seq++}`,
      );
      const toolName = String(
        payload?.toolName ?? payload?.tool_name ?? "tool",
      );
      bubbles.push({
        id: toolCallId,
        type: "tool",
        label: toolName,
        content: "",
        toolName,
        status: "running",
      });
      continue;
    }

    if (
      event.pi_type === "tool_execution_update" ||
      event.pi_type === "tool_execution_end"
    ) {
      const toolCallId = String(payload?.toolCallId ?? payload?.tool_call_id);
      const index = bubbles.findIndex(
        (item) => item.id === toolCallId && item.type === "tool",
      );
      if (index === -1) continue;
      const bubble = bubbles[index];
      const output = extractToolOutput(payload);
      const nextContent = output ? output : bubble.content;
      const nextStatus =
        event.pi_type === "tool_execution_end"
          ? payload?.isError || payload?.is_error
            ? "error"
            : "done"
          : bubble.status;
      bubbles[index] = { ...bubble, content: nextContent, status: nextStatus };
      continue;
    }

    if (event.pi_type === "agent_end" || event.pi_type === "turn_end") {
      for (let i = 0; i < bubbles.length; i++) {
        const bubble = bubbles[i];
        if (bubble.status === "running") {
          bubbles[i] = { ...bubble, status: "done" };
        }
      }
      bubbles.push({
        id: `end-${seq++}`,
        type: "status",
        label: event.pi_type === "agent_end" ? "处理完成" : "本轮处理完成",
        content: "",
        status: "done",
      });
    }
  }

  return bubbles;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function extractToolOutput(payload: Record<string, unknown> | null) {
  const result = asRecord(
    payload?.partialResult ?? payload?.partial_result ?? payload?.result,
  );
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map((item) => asRecord(item)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

export function createDraftAnswer(
  clarification: RequirementClarification,
): DraftClarificationAnswer {
  return {
    selectedOptions: clarification.answer?.selected_options ?? [],
    customText: clarification.answer?.custom_text ?? "",
  };
}

export function hasDraftAnswer(
  clarification: RequirementClarification,
  answer?: DraftClarificationAnswer,
) {
  if (!answer) return false;
  if (clarification.question_type === "free_text") {
    return answer.customText.trim().length > 0;
  }
  return (
    answer.selectedOptions.length > 0 || answer.customText.trim().length > 0
  );
}

export function toggleClarificationOption(
  clarification: RequirementClarification,
  answer: DraftClarificationAnswer,
  value: string,
): DraftClarificationAnswer {
  if (clarification.question_type === "single_choice") {
    return { ...answer, selectedOptions: [value] };
  }

  const selectedOptions = answer.selectedOptions.includes(value)
    ? answer.selectedOptions.filter((item) => item !== value)
    : [...answer.selectedOptions, value];
  return { ...answer, selectedOptions };
}

export function buildClarificationAnswerPayload(
  clarification: RequirementClarification,
  answer: DraftClarificationAnswer,
) {
  return {
    clarification_id: clarification.id,
    selected_options:
      clarification.question_type === "free_text" ? [] : answer.selectedOptions,
    custom_text: answer.customText.trim() || null,
  };
}

export function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }
  return window.localStorage.getItem("raccoon-node-theme") === "light"
    ? "light"
    : "dark";
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function getProjectListHeight(projectCount: number) {
  if (projectCount === 0) {
    return 220;
  }
  return 148 + projectCount * 86 + (projectCount - 1) * 12 + 28;
}
