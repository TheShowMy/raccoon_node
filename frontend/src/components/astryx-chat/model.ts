import type {
  ConversationEvent,
  FileReference,
  ImageAttachment,
  ProjectChatMessage,
  RequirementConversationItem,
  StreamEvent,
  TraceBlock,
  TraceMetadata,
} from "../../types/api";

export type AstryxChatEntry = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  references: FileReference[];
  images: ImageAttachment[];
  traceBlocks: TraceBlock[];
  requirementContext?: ProjectChatMessage["requirement_context"];
  noticeLevel?: "info" | "warn";
};

export type AstryxLiveActivity = {
  thinking: string;
  output: string;
  tools: Array<{
    id: string;
    name: string;
    target: string;
    output: string;
    status: "pending" | "running" | "complete" | "error";
  }>;
  notices: string[];
};

function traceBlocks(metadata: TraceMetadata | null | undefined) {
  if (metadata?.type !== "pi_trace") return [];
  const trace = metadata.trace;
  if (!trace || typeof trace !== "object") return [];
  const storedBlocks = Array.isArray(trace.blocks) ? trace.blocks : [];
  if (storedBlocks.length) return storedBlocks;
  const blocks: TraceBlock[] = [];
  if (typeof trace.thinking === "string" && trace.thinking) {
    blocks.push({
      id: "thinking",
      type: "thinking",
      content: trace.thinking,
      status: "done",
    });
  }
  const tools = Array.isArray(trace.tools) ? trace.tools : [];
  for (const tool of tools) {
    blocks.push({
      id: tool.toolCallId,
      type: "tool",
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      input: tool.input,
      output: tool.output,
      status: tool.status,
      isError: tool.isError,
    });
  }
  return blocks;
}

export function projectMessageEntries(
  messages: ProjectChatMessage[],
): AstryxChatEntry[] {
  return messages.map((message, index) => ({
    id: `project-${index}-${message.created_at}`,
    role: message.role,
    text: message.content,
    createdAt: message.created_at,
    references: message.references ?? [],
    images: message.images ?? [],
    traceBlocks: traceBlocks(message.metadata),
    requirementContext: message.requirement_context,
  }));
}

export function requirementItemEntries(
  items: RequirementConversationItem[],
): AstryxChatEntry[] {
  const entries: AstryxChatEntry[] = [];
  for (const item of items) {
    if (item.kind === "process") {
      entries.push({
        id: item.id,
        role: "assistant",
        text: "",
        createdAt: item.created_at,
        references: [],
        images: [],
        traceBlocks: traceBlocks(item.metadata),
      });
      continue;
    }
    entries.push({
      id: item.id,
      role:
        item.kind === "notice" ? "system" : (item.kind as "user" | "assistant"),
      text: item.text,
      createdAt: item.created_at,
      references: item.kind === "user" ? (item.references ?? []) : [],
      images: item.kind === "user" ? (item.images ?? []) : [],
      traceBlocks: [],
      noticeLevel: item.kind === "notice" ? item.level : undefined,
    });
  }
  return entries;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
    const nested = asRecord(value);
    if (typeof nested.text === "string") return nested.text;
  }
  return "";
}

function normalizeStatus(value: unknown, isError = false) {
  const status = String(value ?? "").toLowerCase();
  if (isError || status.includes("error") || status.includes("failed")) {
    return "error";
  }
  if (
    status === "done" ||
    status === "complete" ||
    status === "completed" ||
    status.endsWith("_end")
  ) {
    return "complete";
  }
  if (status === "pending") return "pending";
  return "running";
}

function mergeStreamChunk(current: string, incoming: string) {
  if (!incoming || current.endsWith(incoming)) return current;
  if (!current || incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  return current + incoming;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).join("");
  const record = asRecord(value);
  for (const key of ["text", "delta", "content", "message"]) {
    if (record[key] !== undefined) {
      const text = extractText(record[key]);
      if (text) return text;
    }
  }
  return "";
}

function toolOutput(
  payload: Record<string, unknown>,
  inner: Record<string, unknown>,
) {
  for (const value of [
    payload.output,
    payload.partialResult,
    payload.result,
    payload.delta,
    inner.output,
    inner.partialResult,
    inner.result,
    inner.delta,
  ]) {
    const text = extractText(value);
    if (text) return text;
  }
  return "";
}

function liveToolTarget(
  payload: Record<string, unknown>,
  inner: Record<string, unknown>,
  fallback = "workspace",
) {
  const direct =
    firstString(payload, ["target", "path", "command"]) ||
    firstString(inner, ["target", "path", "command"]);
  if (direct) return direct;
  const input =
    payload.input ??
    payload.toolInput ??
    payload.tool_input ??
    inner.input ??
    inner.toolInput ??
    inner.tool_input;
  return input === undefined ? fallback : toolTarget(input);
}

export function conversationEventsToStreamEvents(
  events: ConversationEvent[],
): StreamEvent[] {
  return events.map((event) => {
    const payload = event.payload;
    const piEvent =
      typeof payload.event === "object" && payload.event !== null
        ? payload.event
        : (payload.payload ?? payload);
    const eventRecord = asRecord(piEvent);
    return {
      requirement_id:
        typeof payload.requirement_id === "string"
          ? payload.requirement_id
          : "project-chat",
      event:
        typeof eventRecord.type === "string" ? eventRecord.type : event.type,
      message: typeof payload.message === "string" ? payload.message : "",
      pi_type:
        typeof payload.pi_type === "string" ? payload.pi_type : undefined,
      payload: piEvent,
    };
  });
}

export function buildLiveActivity(events: StreamEvent[]): AstryxLiveActivity {
  const activity: AstryxLiveActivity = {
    thinking: "",
    output: "",
    tools: [],
    notices: [],
  };
  const tools = new Map<
    string,
    AstryxLiveActivity["tools"][number] & { anonymous: boolean }
  >();
  const orphanEnds = new Set<string>();
  let anonymousSequence = 0;
  let orphanSequence = 0;

  for (const event of events) {
    const payload = asRecord(event.payload);
    const inner = asRecord(payload.payload);
    const assistant = asRecord(
      payload.assistantMessageEvent ??
        payload.assistant_message_event ??
        inner.assistantMessageEvent ??
        inner.assistant_message_event,
    );
    const piType = String(
      event.pi_type ?? payload.type ?? inner.type ?? event.event,
    ).toLowerCase();
    const assistantType = String(assistant.type ?? "").toLowerCase();
    const delta =
      firstString(payload, ["delta", "text", "content", "message"]) ||
      firstString(inner, ["delta", "text", "content", "message"]) ||
      firstString(assistant, ["delta", "text", "content", "message"]);

    if (
      assistantType.includes("thinking") ||
      assistantType.includes("reasoning") ||
      piType.includes("thinking") ||
      piType.includes("reasoning")
    ) {
      activity.thinking = mergeStreamChunk(activity.thinking, delta);
      continue;
    }
    if (piType.startsWith("tool_execution_")) {
      const explicitId =
        firstString(payload, ["toolCallId", "tool_call_id", "id"]) ||
        firstString(inner, ["toolCallId", "tool_call_id", "id"]);
      const name =
        firstString(payload, ["toolName", "tool_name", "name"]) ||
        firstString(inner, ["toolName", "tool_name", "name"]) ||
        "tool";
      const lifecycle = piType.endsWith("_start")
        ? "start"
        : piType.endsWith("_end")
          ? "end"
          : "update";
      let id = explicitId;
      if (id && lifecycle !== "start" && !tools.has(id)) {
        const anonymous = [...tools.values()]
          .reverse()
          .find(
            (tool) =>
              tool.anonymous &&
              tool.status === "running" &&
              (name === "tool" || tool.name === name),
          );
        if (anonymous) {
          tools.delete(anonymous.id);
          tools.set(id, { ...anonymous, id, anonymous: false });
        }
      }
      if (!id && lifecycle !== "start") {
        const matchingId = [...tools.values()]
          .reverse()
          .find(
            (tool) =>
              tool.status === "running" &&
              (name === "tool" || tool.name === name),
          )?.id;
        if (matchingId) id = matchingId;
      }
      if (!id && lifecycle === "update") continue;
      const output = toolOutput(payload, inner);
      if (!id && lifecycle === "end") {
        const signature = `${name}\u0000${liveToolTarget(payload, inner)}\u0000${output}`;
        if (orphanEnds.has(signature)) continue;
        orphanEnds.add(signature);
        id = `tool-orphan-${orphanSequence++}`;
      }
      id ||= `tool-anonymous-${anonymousSequence++}`;
      const previous = tools.get(id);
      tools.set(id, {
        id,
        name: name === "tool" ? (previous?.name ?? name) : name,
        target: liveToolTarget(payload, inner, previous?.target),
        output: mergeStreamChunk(previous?.output ?? "", output),
        status:
          lifecycle === "end"
            ? normalizeStatus(
                "done",
                Boolean(
                  payload.isError ??
                  payload.is_error ??
                  inner.isError ??
                  inner.is_error,
                ),
              )
            : "running",
        anonymous: previous?.anonymous ?? !explicitId,
      });
      continue;
    }
    if (
      assistantType.includes("text") ||
      assistantType.includes("content") ||
      assistantType.includes("message") ||
      piType.includes("assistant") ||
      piType.includes("output") ||
      piType.includes("message_update") ||
      piType.includes("text_delta")
    ) {
      activity.output = mergeStreamChunk(activity.output, delta);
      continue;
    }
    if (event.event === "notice.append" || event.event === "session.error") {
      if (event.message) activity.notices.push(event.message);
    }
  }
  activity.tools = [...tools.values()].map(({ anonymous: _, ...tool }) => tool);
  return activity;
}

export function hasLiveContent(activity: AstryxLiveActivity) {
  return Boolean(activity.thinking || activity.output || activity.tools.length);
}

export function toolTarget(input: unknown) {
  if (typeof input === "string") return input.slice(0, 160);
  if (input === undefined) return "workspace";
  try {
    return JSON.stringify(input).slice(0, 160);
  } catch {
    return "workspace";
  }
}
