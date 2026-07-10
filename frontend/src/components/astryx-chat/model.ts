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
  const tools = new Map<string, AstryxLiveActivity["tools"][number]>();

  for (const event of events) {
    const payload = asRecord(event.payload);
    const inner = asRecord(payload.payload);
    const assistant = asRecord(
      payload.assistantMessageEvent ??
        payload.assistant_message_event ??
        inner.assistantMessageEvent ??
        inner.assistant_message_event,
    );
    const kind = String(
      assistant.type ??
        event.pi_type ??
        payload.type ??
        inner.type ??
        event.event,
    ).toLowerCase();
    const text =
      firstString(payload, ["delta", "text", "content", "message"]) ||
      firstString(inner, ["delta", "text", "content", "message"]) ||
      firstString(assistant, ["delta", "text", "content", "message"]) ||
      event.message;

    if (kind.includes("thinking") || kind.includes("reasoning")) {
      activity.thinking += text;
      continue;
    }
    if (kind.includes("tool")) {
      const id =
        firstString(payload, ["toolCallId", "tool_call_id", "id"]) ||
        firstString(inner, ["toolCallId", "tool_call_id", "id"]) ||
        `tool-${tools.size}`;
      const previous = tools.get(id);
      const name =
        firstString(payload, ["toolName", "tool_name", "name"]) ||
        firstString(inner, ["toolName", "tool_name", "name"]) ||
        previous?.name ||
        "tool";
      const output =
        firstString(payload, ["output", "result", "delta"]) ||
        firstString(inner, ["output", "result", "delta"]);
      tools.set(id, {
        id,
        name,
        target:
          firstString(payload, ["target", "path", "command"]) ||
          firstString(inner, ["target", "path", "command"]) ||
          previous?.target ||
          "workspace",
        output: `${previous?.output ?? ""}${output}`,
        status: normalizeStatus(
          payload.status ??
            inner.status ??
            payload.type ??
            inner.type ??
            event.pi_type,
          Boolean(payload.isError ?? inner.isError),
        ),
      });
      continue;
    }
    if (
      kind.includes("assistant") ||
      kind.includes("output") ||
      kind.includes("message_update") ||
      kind.includes("text_delta")
    ) {
      activity.output += text;
      continue;
    }
    if (event.event === "notice.append" || event.event === "session.error") {
      if (text) activity.notices.push(text);
    }
  }
  activity.tools = [...tools.values()];
  return activity;
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
