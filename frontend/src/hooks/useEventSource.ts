import { useEffect, useRef, useState } from "react";
import { parseStreamEvent, readError } from "../utils/format";
import type { StreamEvent } from "../types/api";

const MAX_RECONNECT_DELAY_MS = 30000;

export function useEventSource(
  activeRequirementId: string | null,
  selectedProjectId: string | null,
  onEvent: (event: StreamEvent) => void,
  onNonTransient: () => void,
) {
  const onEventRef = useRef(onEvent);
  const onNonTransientRef = useRef(onNonTransient);
  onEventRef.current = onEvent;
  onNonTransientRef.current = onNonTransient;

  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!activeRequirementId || !selectedProjectId) {
      setConnected(false);
      return;
    }

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let aborted = false;

    const connect = () => {
      if (aborted) return;
      source = new EventSource(
        `/api/requirements/${encodeURIComponent(activeRequirementId)}/events`,
      );

      source.onopen = () => {
        setConnected(true);
        reconnectAttempts = 0;
      };

      const handleEvent = (event: MessageEvent<string>) => {
        const parsed = parseStreamEvent(event.data);
        if (!parsed) {
          return;
        }
        onEventRef.current(parsed);

        const transient =
          parsed.event === "coordinator_started" ||
          parsed.event === "coordinator_progress" ||
          parsed.event === "pi_event";
        if (!transient) {
          onNonTransientRef.current();
        }
      };

      source.onmessage = handleEvent;
      for (const eventName of [
        "coordinator_started",
        "coordinator_progress",
        "pi_event",
        "clarifications_ready",
        "draft_ready",
        "analysis_failed",
      ]) {
        source.addEventListener(eventName, handleEvent);
      }

      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (aborted) return;

        const delay = Math.min(
          1000 * 2 ** reconnectAttempts,
          MAX_RECONNECT_DELAY_MS,
        );
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      aborted = true;
      source?.close();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [activeRequirementId, selectedProjectId]);

  return { connected };
}
