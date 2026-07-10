import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  abortProjectChat,
  getProjectChat,
  projectChatWebSocketUrl,
  resetProjectChat,
  sendProjectChatMessage,
} from "../api/client";
import type {
  ChatSubmission,
  ConversationEvent,
  ProjectChatResponse,
} from "../types/api";
import { readError } from "../utils/format";
import { useConversationSocket } from "./useConversationSocket";

export function useProjectChat(projectId: string | null) {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [projectChat, setProjectChat] = useState<ProjectChatResponse | null>(
    null,
  );
  const [projectChatBusy, setProjectChatBusy] = useState(false);
  const [projectChatError, setProjectChatError] = useState<string | null>(null);
  const [projectChatEvents, setProjectChatEvents] = useState<
    ConversationEvent[]
  >([]);

  useEffect(() => {
    setProjectChat(null);
    setProjectChatBusy(false);
    setProjectChatError(null);
    setProjectChatEvents([]);
  }, [projectId]);

  const loadProjectChat = useCallback(async () => {
    if (!projectId) throw new Error("项目未加载");
    return getProjectChat(projectId);
  }, [projectId]);

  const applySnapshot = useCallback((snapshot: ProjectChatResponse) => {
    if (projectIdRef.current !== snapshot.project_id) return;
    setProjectChat(snapshot);
    setProjectChatError(snapshot.error);
    setProjectChatEvents((current) => (snapshot.running ? current : []));
  }, []);

  const handleEvent = useCallback((event: ConversationEvent) => {
    const eventProjectId = event.payload.project_id;
    if (
      typeof eventProjectId === "string" &&
      eventProjectId !== projectIdRef.current
    ) {
      return;
    }
    if (event.type === "session.error") {
      setProjectChatError(
        typeof event.payload.message === "string"
          ? event.payload.message
          : "项目问答失败",
      );
    }
    setProjectChatEvents((current) => [...current, event]);
  }, []);

  useConversationSocket({
    url: useMemo(
      () => (projectId ? projectChatWebSocketUrl(projectId) : null),
      [projectId],
    ),
    loadSnapshot: loadProjectChat,
    onSnapshot: applySnapshot,
    onEvent: handleEvent,
    onError: setProjectChatError,
  });

  const run = useCallback(
    async (operation: () => Promise<unknown>): Promise<boolean> => {
      if (!projectId || projectChatBusy || projectChat?.running) return false;
      setProjectChatBusy(true);
      setProjectChatError(null);
      try {
        await operation();
        setProjectChat((current) =>
          current ? { ...current, running: true, error: null } : current,
        );
        return true;
      } catch (reason) {
        setProjectChatError(readError(reason));
        return false;
      } finally {
        setProjectChatBusy(false);
      }
    },
    [projectChat?.running, projectChatBusy, projectId],
  );

  const sendProjectChat = useCallback(
    async (payload: ChatSubmission): Promise<boolean> => {
      const message = payload.message.trim();
      if (!projectId || !message) return false;
      return run(() =>
        sendProjectChatMessage(projectId, { ...payload, message }),
      );
    },
    [projectId, run],
  );

  const abort = useCallback(async () => {
    if (!projectId || projectChatBusy || !projectChat?.running) return;
    setProjectChatBusy(true);
    setProjectChatError(null);
    try {
      await abortProjectChat(projectId);
    } catch (reason) {
      setProjectChatError(readError(reason));
    } finally {
      setProjectChatBusy(false);
    }
  }, [applySnapshot, projectChat?.running, projectChatBusy, projectId]);

  const closeProjectChat = useCallback(async (): Promise<boolean> => {
    if (!projectId || projectChatBusy || projectChat?.running) return false;
    setProjectChatBusy(true);
    setProjectChatError(null);
    try {
      applySnapshot(await resetProjectChat(projectId));
      return true;
    } catch (reason) {
      setProjectChatError(readError(reason));
      return false;
    } finally {
      setProjectChatBusy(false);
    }
  }, [applySnapshot, projectChat?.running, projectChatBusy, projectId]);

  return {
    projectChat,
    projectChatBusy,
    projectChatError,
    projectChatEvents,
    sendProjectChat,
    abortProjectChat: abort,
    closeProjectChat,
  };
}
