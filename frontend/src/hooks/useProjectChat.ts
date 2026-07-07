import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  abortProjectChat,
  generateProjectRequirementSummary,
  getProjectChat,
  projectChatWebSocketUrl,
  resetProjectChat,
  sendProjectChatMessage,
} from "../api/client";
import type {
  ConversationEvent,
  FileReference,
  ImageAttachment,
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
    ConversationEvent[]
  >([]);

  useEffect(() => {
    setProjectChat(null);
    setProjectChatInput("");
    setProjectChatReferences([]);
    setProjectChatImages([]);
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
    setProjectChatEvents([]);
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
    if (event.type === "status.update") {
      const running = event.payload.running;
      if (typeof running === "boolean") {
        setProjectChat((current) =>
          current ? { ...current, running } : current,
        );
      }
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
    async (operation: () => Promise<unknown>, clearComposer = false) => {
      if (!projectId || projectChatBusy || projectChat?.running) return;
      setProjectChatBusy(true);
      setProjectChatError(null);
      try {
        await operation();
        setProjectChat((current) =>
          current ? { ...current, running: true, error: null } : current,
        );
        if (clearComposer) {
          setProjectChatInput("");
          setProjectChatReferences([]);
          setProjectChatImages([]);
        }
      } catch (reason) {
        setProjectChatError(readError(reason));
      } finally {
        setProjectChatBusy(false);
      }
    },
    [projectChat?.running, projectChatBusy, projectId],
  );

  const sendProjectChat = useCallback(async () => {
    const message = projectChatInput.trim();
    if (!projectId || !message) return;
    await run(
      () =>
        sendProjectChatMessage(projectId, {
          message,
          references: projectChatReferences,
          images: projectChatImages,
        }),
      true,
    );
  }, [
    projectChatImages,
    projectChatInput,
    projectChatReferences,
    projectId,
    run,
  ]);

  const generateRequirementSummary = useCallback(async () => {
    if (!projectId) return;
    setProjectChatInput("");
    await run(() => generateProjectRequirementSummary(projectId));
  }, [projectId, run]);

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

  const closeProjectChat = useCallback(async () => {
    if (!projectId || projectChatBusy || projectChat?.running) return;
    setProjectChatBusy(true);
    setProjectChatError(null);
    try {
      applySnapshot(await resetProjectChat(projectId));
      setProjectChatInput("");
      setProjectChatReferences([]);
      setProjectChatImages([]);
    } catch (reason) {
      setProjectChatError(readError(reason));
    } finally {
      setProjectChatBusy(false);
    }
  }, [applySnapshot, projectChat?.running, projectChatBusy, projectId]);

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
    generateRequirementSummary,
    abortProjectChat: abort,
    closeProjectChat,
  };
}
