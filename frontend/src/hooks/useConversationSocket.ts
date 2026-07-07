import { useEffect, useRef } from "react";
import type { ConversationEvent } from "../types/api";

const EVENT_TYPES = new Set<ConversationEvent["type"]>([
  "message.append",
  "assistant.delta",
  "assistant.thinking.delta",
  "tool.start",
  "tool.update",
  "tool.end",
  "message.end",
  "status.update",
  "snapshot.changed",
  "session.error",
]);

function parseConversationEvent(data: string): ConversationEvent | null {
  try {
    const value = JSON.parse(data) as {
      type?: unknown;
      payload?: unknown;
    };
    if (
      typeof value.type !== "string" ||
      !EVENT_TYPES.has(value.type as ConversationEvent["type"]) ||
      !value.payload ||
      typeof value.payload !== "object" ||
      Array.isArray(value.payload)
    ) {
      return null;
    }
    return value as ConversationEvent;
  } catch {
    return null;
  }
}

export function useConversationSocket<T>({
  url,
  loadSnapshot,
  onSnapshot,
  onEvent,
  onError,
}: {
  url: string | null;
  loadSnapshot: () => Promise<T>;
  onSnapshot: (snapshot: T) => void;
  onEvent: (event: ConversationEvent) => void;
  onError: (message: string) => void;
}) {
  const callbacks = useRef({ loadSnapshot, onSnapshot, onEvent, onError });
  callbacks.current = { loadSnapshot, onSnapshot, onEvent, onError };

  useEffect(() => {
    if (!url) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let syncing = false;
    let resyncRequested = false;
    const buffer: ConversationEvent[] = [];

    const sync = async () => {
      if (syncing || disposed) return;
      syncing = true;
      try {
        const snapshot = await callbacks.current.loadSnapshot();
        if (disposed) return;
        callbacks.current.onSnapshot(snapshot);
        const pending = buffer.splice(0);
        pending.forEach(callbacks.current.onEvent);
        resyncRequested = pending.some(
          (event) =>
            event.type === "snapshot.changed" || event.type === "message.end",
        );
      } catch (error) {
        callbacks.current.onError(
          error instanceof Error ? error.message : "同步会话失败",
        );
      } finally {
        syncing = false;
        if (resyncRequested) {
          resyncRequested = false;
          void sync();
        }
      }
    };

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(url);
      socket.onopen = () => {
        reconnectAttempt = 0;
        if (syncing) {
          resyncRequested = true;
        } else {
          void sync();
        }
      };
      socket.onmessage = (message) => {
        const event = parseConversationEvent(String(message.data));
        if (!event) return;
        if (syncing) {
          buffer.push(event);
          return;
        }
        callbacks.current.onEvent(event);
        if (event.type === "snapshot.changed" || event.type === "message.end") {
          void sync();
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        const delay = Math.min(500 * 2 ** reconnectAttempt++, 8_000);
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [url]);
}
