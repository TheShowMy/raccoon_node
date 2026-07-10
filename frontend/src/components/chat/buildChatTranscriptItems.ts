import type {
  ProjectChatResponse,
  ConversationEvent,
  RequirementConversation,
  StreamEvent,
} from "../../types/api";
import {
  buildProcessRowsFromAgentEvents,
  buildProcessRowsFromTrace,
  buildStreamingTextFromAgentEvents,
  traceFromMetadata,
} from "../../utils/format";
import type { ChatTranscriptItem } from "./types";

export function buildRequirementChatItems(
  conversation: RequirementConversation | null,
  streamEvents: StreamEvent[],
  onCancel: () => void,
): ChatTranscriptItem[] {
  const items: ChatTranscriptItem[] = [];
  const fallbackTime = conversation?.updated_at ?? new Date().toISOString();

  if (conversation) {
    for (const item of conversation.items) {
      if (item.kind === "user" || item.kind === "assistant") {
        items.push({
          kind: "message",
          id: item.id,
          role: item.kind,
          content: item.text,
          created_at: item.created_at,
          references: item.kind === "user" ? item.references : undefined,
          images: item.kind === "user" ? item.images : undefined,
          assistantLabel: "Coordinator",
        });
      } else if (item.kind === "notice") {
        items.push({
          kind: "notice",
          id: item.id,
          level: item.level === "warn" ? "warning" : "info",
          text: item.text,
          created_at: item.created_at,
        });
      } else if (item.kind === "process") {
        const trace = traceFromMetadata(item.metadata);
        if (trace) {
          items.push({
            kind: "process",
            id: item.id,
            created_at: item.created_at,
            rows: buildProcessRowsFromTrace(trace),
            assistantLabel: "Coordinator",
          });
        }
      }
    }
  }

  const lastNotice = [...streamEvents]
    .reverse()
    .find((event) => event.event === "notice.append");
  if (lastNotice) {
    items.push({
      kind: "notice",
      id: `notice-${lastNotice.requirement_id}`,
      level: "info",
      text: lastNotice.message,
      created_at: fallbackTime,
    });
  }

  if (
    streamEvents.some((event) => event.event === "coordinator_time_warning")
  ) {
    items.push({
      kind: "notice",
      id: "coordinator-time-warning",
      level: "warning",
      text: "分析耗时较长，是否继续等待？",
      created_at: fallbackTime,
      action: {
        label: "停止分析",
        onClick: onCancel,
        variant: "destructive",
      },
    });
  }

  const liveRows = buildProcessRowsFromAgentEvents(streamEvents);
  if (liveRows.length > 0) {
    items.push({
      kind: "process",
      id: "live-process",
      created_at: fallbackTime,
      rows: liveRows,
      assistantLabel: "Coordinator",
    });
  }

  return items;
}

export function buildProjectChatItems(
  projectChat: ProjectChatResponse | null,
  events: ConversationEvent[],
  onRetrySummary?: (requirementId: string) => void,
  onOpenRequirement?: (requirementId: string) => void,
): ChatTranscriptItem[] {
  const items: ChatTranscriptItem[] = [];
  const fallbackTime = projectChat?.updated_at ?? new Date().toISOString();

  if (projectChat) {
    for (const [index, message] of projectChat.messages.entries()) {
      if (message.requirement_context) {
        const context = message.requirement_context;
        items.push({
          kind: "requirement_summary",
          id: `requirement-summary-${context.requirement_id}`,
          requirementId: context.requirement_id,
          draft: context.draft,
          status: context.sync_status,
          error: context.sync_error,
          created_at: message.created_at,
          onOpen: onOpenRequirement
            ? () => onOpenRequirement(context.requirement_id)
            : undefined,
          onRetry:
            context.sync_status === "failed" && onRetrySummary
              ? () => onRetrySummary(context.requirement_id)
              : undefined,
        });
        continue;
      }
      const processRows =
        message.role === "assistant"
          ? buildProcessRowsFromTrace(
              traceFromMetadata(message.metadata) ?? {
                blocks: [],
                thinking: "",
                output: "",
                tools: [],
                statuses: [],
              },
            )
          : [];
      items.push({
        kind: "message",
        id: `project-msg-${index}`,
        role: message.role,
        content: message.content,
        created_at: message.created_at,
        references: message.references,
        images: message.images,
        assistantLabel: "Pi Agent",
        processRows,
      });
    }
  }

  for (const [index, event] of events
    .filter((event) => event.type === "notice.append")
    .entries()) {
    const message =
      typeof event.payload.message === "string" ? event.payload.message : "";
    items.push({
      kind: "notice",
      id: `project-notice-${index}`,
      level: "info",
      text: message,
      created_at: fallbackTime,
    });
  }

  const liveRows = buildProcessRowsFromAgentEvents(events);
  if (liveRows.length > 0) {
    items.push({
      kind: "process",
      id: "project-live-process",
      created_at: fallbackTime,
      rows: liveRows,
      assistantLabel: "Pi Agent",
    });
  }

  const streamingText = buildStreamingTextFromAgentEvents(events);
  if (streamingText) {
    items.push({
      kind: "message",
      id: "project-streaming",
      role: "assistant",
      content: streamingText,
      created_at: fallbackTime,
      assistantLabel: "Pi Agent",
    });
  }

  return items;
}
