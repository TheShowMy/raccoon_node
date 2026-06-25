import { useCallback, useEffect, useRef, useState } from "react";
import { getProjectChat, sendProjectChatMessage } from "../api/client";
import type { ProjectChatEvent, ProjectChatResponse } from "../types/api";
import { readError } from "../utils/format";

function isProjectChatEvent(value: unknown): value is ProjectChatEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.project_id === "string" &&
    typeof event.event === "string" &&
    typeof event.message === "string"
  );
}

export function useProjectChat(projectId: string | null) {
  const projectIdRef = useRef(projectId);
  const [projectChat, setProjectChat] = useState<ProjectChatResponse | null>(
    null,
  );
  const [projectChatInput, setProjectChatInput] = useState("");
  const [projectChatBusy, setProjectChatBusy] = useState(false);
  const [projectChatError, setProjectChatError] = useState<string | null>(null);
  const [projectChatEvents, setProjectChatEvents] = useState<
    ProjectChatEvent[]
  >([]);

  const loadProjectChat = useCallback(async (id: string) => {
    const data = await getProjectChat(id);
    if (projectIdRef.current !== id) return data;
    setProjectChat(data);
    setProjectChatError(data.error);
    return data;
  }, []);

  useEffect(() => {
    projectIdRef.current = projectId;
    setProjectChat(null);
    setProjectChatInput("");
    setProjectChatError(null);
    setProjectChatEvents([]);
    if (!projectId) return;

    void loadProjectChat(projectId).catch((reason) =>
      setProjectChatError(readError(reason)),
    );

    const source = new EventSource(
      `/api/projects/${encodeURIComponent(projectId)}/chat/events`,
    );
    const handleEvent = (event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!isProjectChatEvent(parsed) || parsed.project_id !== projectId) {
          return;
        }
        setProjectChatEvents((current) => [...current, parsed]);
        if (
          parsed.event !== "pi_event" ||
          parsed.pi_type === "agent_end" ||
          parsed.pi_type === "turn_end"
        ) {
          void loadProjectChat(projectId).catch((reason) =>
            setProjectChatError(readError(reason)),
          );
        }
      } catch (error) {
        console.error(
          "Project chat EventSource parse error",
          error,
          event.data,
        );
      }
    };

    source.onmessage = handleEvent;
    for (const eventName of [
      "pi_event",
      "chat_started",
      "chat_updated",
      "chat_completed",
      "chat_failed",
      "started",
      "completed",
      "failed",
    ]) {
      source.addEventListener(eventName, handleEvent);
    }
    return () => source.close();
  }, [loadProjectChat, projectId]);

  const sendProjectChat = useCallback(async () => {
    const message = projectChatInput.trim();
    if (!projectId || !message || projectChatBusy) return;

    setProjectChatBusy(true);
    setProjectChatError(null);
    try {
      const data = await sendProjectChatMessage(projectId, message);
      setProjectChat(data);
      setProjectChatInput("");
      setProjectChatEvents([]);
      setProjectChatError(data.error);
    } catch (reason) {
      setProjectChatError(readError(reason));
    } finally {
      setProjectChatBusy(false);
    }
  }, [projectChatBusy, projectChatInput, projectId]);

  return {
    projectChat,
    projectChatInput,
    projectChatBusy,
    projectChatError,
    projectChatEvents,
    setProjectChatInput,
    sendProjectChat,
  };
}
