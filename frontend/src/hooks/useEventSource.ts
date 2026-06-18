import { useEffect, useRef, useState } from "react";
import { parseStreamEvent, readError } from "../utils/format";
import type { StreamEvent } from "../types/api";

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

  useEffect(() => {
    if (!activeRequirementId || !selectedProjectId) {
      return;
    }

    const source = new EventSource(
      `/api/requirements/${encodeURIComponent(activeRequirementId)}/events`,
    );

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

    return () => source.close();
  }, [activeRequirementId, selectedProjectId]);
}
