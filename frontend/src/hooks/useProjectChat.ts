import { useCallback, useEffect, useRef, useState } from "react";
import {
  getProjectChat,
  resetProjectChat,
  sendProjectChatMessage,
} from "../api/client";
import type {
  FileReference,
  ImageAttachment,
  ProjectChatEvent,
  ProjectChatResponse,
} from "../types/api";
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
  const [projectChatReferences, setProjectChatReferences] = useState<
    FileReference[]
  >([]);
  const [projectChatImages, setProjectChatImages] = useState<ImageAttachment[]>(
    [],
  );
  const [projectChatBusy, setProjectChatBusy] = useState(false);
  const [projectChatError, setProjectChatError] = useState<string | null>(null);
  const [projectChatEvents, setProjectChatEvents] = useState<
    ProjectChatEvent[]
  >([]);
  const chatEventBufferRef = useRef<ProjectChatEvent[]>([]);
  const chatFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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
    setProjectChatReferences([]);
    setProjectChatImages([]);
    setProjectChatError(null);
    setProjectChatEvents([]);
    chatEventBufferRef.current = [];
    if (chatFlushTimeoutRef.current !== null) {
      clearTimeout(chatFlushTimeoutRef.current);
      chatFlushTimeoutRef.current = null;
    }
    if (!projectId) return;

    void loadProjectChat(projectId).catch((reason) =>
      setProjectChatError(readError(reason)),
    );

    const finalEvents = new Set([
      "project_chat_completed",
      "project_chat_failed",
      "chat_completed",
      "chat_failed",
      "completed",
      "failed",
    ]);

    const flushChatEvents = () => {
      chatFlushTimeoutRef.current = null;
      const batch = chatEventBufferRef.current;
      if (batch.length === 0) return;
      chatEventBufferRef.current = [];
      setProjectChatEvents((current) => {
        const next = [...current, ...batch];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
      if (batch.some((event) => finalEvents.has(event.event))) {
        void loadProjectChat(projectId)
          .then(() => {
            if (projectIdRef.current === projectId) {
              setProjectChatEvents([]);
            }
          })
          .catch((reason) => setProjectChatError(readError(reason)));
      }
    };

    const scheduleChatFlush = () => {
      if (chatFlushTimeoutRef.current !== null) return;
      chatFlushTimeoutRef.current = setTimeout(flushChatEvents, 50);
    };

    const source = new EventSource(
      `/api/projects/${encodeURIComponent(projectId)}/chat/events`,
    );
    const handleEvent = (event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!isProjectChatEvent(parsed) || parsed.project_id !== projectId) {
          return;
        }
        chatEventBufferRef.current.push(parsed);
        scheduleChatFlush();
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
      "project_chat_started",
      "project_chat_completed",
      "project_chat_failed",
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
    return () => {
      if (chatFlushTimeoutRef.current !== null) {
        clearTimeout(chatFlushTimeoutRef.current);
        chatFlushTimeoutRef.current = null;
      }
      chatEventBufferRef.current = [];
      source.close();
    };
  }, [loadProjectChat, projectId]);

  const sendProjectChat = useCallback(async () => {
    const message = projectChatInput.trim();
    if (!projectId || !message || projectChatBusy) return;

    setProjectChatBusy(true);
    setProjectChatError(null);
    try {
      const data = await sendProjectChatMessage(projectId, {
        message,
        references: projectChatReferences,
        images: projectChatImages,
      });
      setProjectChat(data);
      setProjectChatInput("");
      setProjectChatReferences([]);
      setProjectChatImages([]);
      setProjectChatEvents([]);
      setProjectChatError(data.error);
    } catch (reason) {
      setProjectChatError(readError(reason));
    } finally {
      setProjectChatBusy(false);
    }
  }, [
    projectChatBusy,
    projectChatImages,
    projectChatInput,
    projectChatReferences,
    projectId,
  ]);

  const closeProjectChat = useCallback(async () => {
    if (!projectId || projectChatBusy || projectChat?.running) return;

    setProjectChatBusy(true);
    setProjectChatError(null);
    try {
      const data = await resetProjectChat(projectId);
      setProjectChat(data);
      setProjectChatInput("");
      setProjectChatReferences([]);
      setProjectChatImages([]);
      setProjectChatEvents([]);
    } catch (reason) {
      setProjectChatError(readError(reason));
    } finally {
      setProjectChatBusy(false);
    }
  }, [projectChat?.running, projectChatBusy, projectId]);

  return {
    projectChat,
    projectChatInput,
    projectChatReferences,
    projectChatImages,
    projectChatBusy,
    projectChatError,
    projectChatEvents,
    setProjectChatInput,
    setProjectChatReferences,
    setProjectChatImages,
    sendProjectChat,
    closeProjectChat,
  };
}
