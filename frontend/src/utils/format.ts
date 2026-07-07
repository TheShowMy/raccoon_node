import {
  type ClarificationQuestionType,
  type RequirementClarification,
  type DraftClarificationAnswer,
  type RequirementStatus,
  type RequirementMessage,
  type ConversationEvent,
  type LiveBubble,
  type TraceData,
  type TraceBlock,
  type TraceMetadata,
  type StreamEvent,
  type ModelSettings,
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

export type ProcessRow =
  | {
      id: string;
      type: "thinking";
      content: string;
      status: "running" | "done" | "error";
    }
  | {
      id: string;
      type: "tool";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      output: string;
      preview: string;
      status: "running" | "done" | "error";
      isError?: boolean;
    };

type AgentEventLike =
  | Pick<ConversationEvent, "type" | "payload">
  | Pick<StreamEvent, "event" | "message" | "pi_type" | "payload">;

type ToolOutputState = {
  content: string;
  lastChunk: string;
};

function mergeStreamText(
  current: string,
  incoming: string,
  lastChunk = "",
): { content: string; lastChunk: string } {
  if (!incoming || incoming === lastChunk || current.endsWith(incoming)) {
    return { content: current, lastChunk };
  }
  if (!current || incoming.startsWith(current)) {
    return { content: incoming, lastChunk: incoming };
  }
  const separator =
    current.endsWith("\n") || incoming.startsWith("\n") ? "" : "\n";
  return { content: `${current}${separator}${incoming}`, lastChunk: incoming };
}

export function buildBubbleStreamFromEvents(
  events: Pick<StreamEvent, "event" | "message" | "pi_type" | "payload">[],
): LiveBubble[] {
  return buildProcessRowsFromAgentEvents(events).map((row) =>
    row.type === "thinking"
      ? {
          id: row.id,
          type: "thinking",
          label: "Thinking",
          content: row.content,
          status: row.status,
        }
      : {
          id: row.id,
          type: "tool",
          label: row.toolName,
          content: row.output,
          preview: row.preview,
          toolName: row.toolName,
          status: row.status,
        },
  );
}

export function buildBubbleStreamFromTrace(trace: TraceData): LiveBubble[] {
  return buildProcessRowsFromTrace(trace).map((row) =>
    row.type === "thinking"
      ? {
          id: row.id,
          type: "thinking",
          label: "Thinking",
          content: row.content,
          status: row.status,
        }
      : {
          id: row.id,
          type: "tool",
          label: row.toolName,
          content: row.output,
          preview: row.preview,
          toolName: row.toolName,
          status: row.status,
        },
  );
}

export function buildProcessRowsFromTrace(trace: TraceData): ProcessRow[] {
  if (trace.blocks?.length) {
    return trace.blocks.flatMap((block) => processRowFromTraceBlock(block));
  }
  const rows: ProcessRow[] = [];
  if (trace.thinking?.trim()) {
    rows.push({
      id: "thinking-0",
      type: "thinking",
      content: trace.thinking,
      status: "done",
    });
  }
  for (const tool of trace.tools ?? []) {
    rows.push({
      id: tool.toolCallId,
      type: "tool",
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      input: tool.input,
      output: tool.output,
      preview: toolPreviewFromPayload(asRecord(tool.input)),
      status: normalizeProcessStatus(tool.status, tool.isError),
      isError: tool.isError,
    });
  }
  return rows;
}

function processRowFromTraceBlock(block: TraceBlock): ProcessRow[] {
  if (block.type === "thinking") {
    return block.content.trim()
      ? [
          {
            id: block.id,
            type: "thinking",
            content: block.content,
            status: normalizeProcessStatus(block.status),
          },
        ]
      : [];
  }
  return [
    {
      id: block.id || block.toolCallId,
      type: "tool",
      toolCallId: block.toolCallId,
      toolName: block.toolName,
      input: block.input,
      output: block.output,
      preview: toolPreviewFromPayload(asRecord(block.input)),
      status: normalizeProcessStatus(block.status, block.isError),
      isError: block.isError,
    },
  ];
}

export function buildProcessRowsFromAgentEvents(
  events: AgentEventLike[],
): ProcessRow[] {
  const rows: ProcessRow[] = [];
  const toolOutputs = new Map<string, ToolOutputState>();
  let seq = 0;

  for (const event of events) {
    const raw = rawPiEvent(event);
    const piType = rawPiType(event, raw);
    if (!raw || !piType) continue;

    const assistantDelta = readAssistantMessageDelta(event, raw);
    if (assistantDelta) {
      if (assistantDelta.type !== "thinking_delta" || !assistantDelta.delta) {
        continue;
      }
      const last = rows.at(-1);
      if (last?.type === "thinking") {
        rows[rows.length - 1] = {
          ...last,
          content: last.content + assistantDelta.delta,
        };
      } else {
        rows.push({
          id: `thinking-${seq++}`,
          type: "thinking",
          content: assistantDelta.delta,
          status: "running",
        });
      }
      continue;
    }

    if (
      piType === "tool_execution_start" ||
      piType === "tool_execution_update" ||
      piType === "tool_execution_end"
    ) {
      const toolCallId = String(
        raw.toolCallId ?? raw.tool_call_id ?? `tool-${seq++}`,
      );
      let index = rows.findIndex(
        (item) => item.type === "tool" && item.toolCallId === toolCallId,
      );
      if (index === -1) {
        rows.push({
          id: toolCallId,
          type: "tool",
          toolCallId,
          toolName: String(raw.toolName ?? raw.tool_name ?? "tool"),
          input: toolInputFromPayload(raw),
          output: "",
          preview: toolPreviewFromPayload(raw),
          status: "running",
        });
        index = rows.length - 1;
      }
      const row = rows[index];
      if (row.type !== "tool") continue;
      const output = extractToolOutput(raw);
      const state = toolOutputs.get(toolCallId) ?? {
        content: row.output,
        lastChunk: "",
      };
      const merged = output
        ? mergeStreamText(state.content, output, state.lastChunk)
        : state;
      toolOutputs.set(toolCallId, merged);
      rows[index] = {
        ...row,
        toolName: String(raw.toolName ?? raw.tool_name ?? row.toolName),
        input: row.input ?? toolInputFromPayload(raw),
        output: merged.content,
        preview: toolPreviewFromPayload(raw) || row.preview,
        status:
          piType === "tool_execution_end"
            ? normalizeProcessStatus(
                "done",
                Boolean(raw.isError ?? raw.is_error),
              )
            : row.status,
        isError: Boolean(raw.isError ?? raw.is_error) || row.isError,
      };
    }
  }

  return rows;
}

export function buildStreamingTextFromAgentEvents(
  events: AgentEventLike[],
): string {
  const parts: string[] = [];

  for (const event of events) {
    const raw = rawPiEvent(event);
    if (!raw) continue;

    const assistantDelta = readAssistantMessageDelta(event, raw);
    if (!assistantDelta) continue;

    if (assistantDelta.type === "thinking_delta") continue;
    if (
      assistantDelta.type !== "text_delta" &&
      assistantDelta.type !== "content_delta" &&
      assistantDelta.type !== "message_delta" &&
      assistantDelta.type !== ""
    ) {
      continue;
    }

    if (assistantDelta.delta) {
      parts.push(assistantDelta.delta);
    }
  }

  return parts.join("");
}

export const buildStreamingTextFromEvents = buildStreamingTextFromAgentEvents;

function rawPiEvent(event: AgentEventLike): Record<string, unknown> | null {
  if ("type" in event) {
    if (event.type !== "agent.event") return null;
    return asRecord(event.payload.event ?? event.payload);
  }
  if (event.event !== "agent.event" && event.event !== "pi_event") return null;
  return asRecord(event.payload);
}

function rawPiType(
  event: AgentEventLike,
  raw: Record<string, unknown> | null,
): string {
  if ("type" in event) {
    return String(event.payload.pi_type ?? raw?.type ?? "");
  }
  return String(event.pi_type ?? raw?.type ?? "");
}

const ASSISTANT_DELTA_TYPES = new Set([
  "thinking_delta",
  "text_delta",
  "content_delta",
  "message_delta",
]);

function readAssistantMessageDelta(
  event: AgentEventLike,
  raw: Record<string, unknown>,
): { type: string; delta: string } | null {
  const piType = rawPiType(event, raw);
  if (piType === "message_update") {
    const assistantEvent = asRecord(raw.assistantMessageEvent);
    if (!assistantEvent) return null;
    return {
      type: String(assistantEvent.type ?? ""),
      delta: String(assistantEvent.delta ?? assistantEvent.text ?? ""),
    };
  }
  if (ASSISTANT_DELTA_TYPES.has(piType)) {
    return {
      type: piType,
      delta: String(raw.delta ?? raw.text ?? ""),
    };
  }
  return null;
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

function toolInputFromPayload(payload: Record<string, unknown> | null) {
  if (!payload) return undefined;
  return (
    payload.input ??
    payload.arguments ??
    payload.args ??
    payload.toolInput ??
    payload.tool_input ??
    payload.toolArguments ??
    payload.tool_arguments
  );
}

function toolPreviewFromPayload(payload: Record<string, unknown> | null) {
  if (!payload) return "";
  const input = toolInputFromPayload(payload);
  for (const source of [input, directUsefulFields(payload)]) {
    const found = findUsefulString(source);
    if (found) return found;
  }
  return "";
}

function findUsefulString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of usefulPreviewKeys) {
    const found = findUsefulString(record[key]);
    if (found) return found;
  }
  for (const item of Object.values(record)) {
    const found = findUsefulString(item);
    if (found) return found;
  }
}

const usefulPreviewKeys = [
  "path",
  "file",
  "filePath",
  "file_path",
  "filename",
  "command",
  "cmd",
  "url",
  "query",
  "pattern",
] as const;

function directUsefulFields(record: Record<string, unknown>) {
  const picked: Record<string, unknown> = {};
  for (const key of usefulPreviewKeys) {
    picked[key] = record[key];
  }
  return picked;
}

function normalizeProcessStatus(
  status: string | undefined,
  isError = false,
): ProcessRow["status"] {
  if (isError || status === "error") return "error";
  if (status === "running") return "running";
  return "done";
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

export function formatCompactNumber(value: number): string {
  if (value >= 100_000_000) {
    return `${(value / 100_000_000).toFixed(1)}亿`;
  }
  if (value >= 10_000) {
    return `${(value / 10_000).toFixed(1)}万`;
  }
  return value.toLocaleString("zh-CN");
}
