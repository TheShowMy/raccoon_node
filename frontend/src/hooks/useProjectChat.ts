import { useCallback, useMemo, useState } from "react";
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

export function useProjectChat() {
  const [projectChat, setProjectChat] = useState<ProjectChatResponse | null>(
    null,
  );
  const [projectChatBusy, setProjectChatBusy] = useState(false);
  const [projectChatError, setProjectChatError] = useState<string | null>(null);
  const [projectChatEvents, setProjectChatEvents] = useState<
    ConversationEvent[]
  >([]);

  const loadProjectChat = useCallback(async () => {
    return getProjectChat();
  }, []);

  const applySnapshot = useCallback((snapshot: ProjectChatResponse) => {
    setProjectChat(snapshot);
    setProjectChatError(snapshot.error);
    setProjectChatEvents((current) => (snapshot.running ? current : []));
  }, []);

  const handleEvent = useCallback((event: ConversationEvent) => {
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
    url: useMemo(() => projectChatWebSocketUrl(), []),
    loadSnapshot: loadProjectChat,
    onSnapshot: applySnapshot,
    onEvent: handleEvent,
    onError: setProjectChatError,
  });

  const run = useCallback(
    async (operation: () => Promise<unknown>): Promise<boolean> => {
      if (projectChatBusy || projectChat?.running) return false;
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
    [projectChat?.running, projectChatBusy],
  );

  const sendProjectChat = useCallback(
    async (payload: ChatSubmission): Promise<boolean> => {
      const message = payload.message.trim();
      if (!message) return false;
      return run(() => sendProjectChatMessage({ ...payload, message }));
    },
    [run],
  );

  const abort = useCallback(async () => {
    if (projectChatBusy || !projectChat?.running) return;
    setProjectChatBusy(true);
    setProjectChatError(null);
    try {
      await abortProjectChat();
    } catch (reason) {
      setProjectChatError(readError(reason));
    } finally {
      setProjectChatBusy(false);
    }
  }, [projectChat?.running, projectChatBusy]);

  const closeProjectChat = useCallback(async (): Promise<boolean> => {
    if (projectChatBusy || projectChat?.running) return false;
    setProjectChatBusy(true);
    setProjectChatError(null);
    try {
      applySnapshot(await resetProjectChat());
      return true;
    } catch (reason) {
      setProjectChatError(readError(reason));
      return false;
    } finally {
      setProjectChatBusy(false);
    }
  }, [applySnapshot, projectChat?.running, projectChatBusy]);

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
