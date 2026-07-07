import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DraftClarificationAnswer,
  FileReference,
  ImageAttachment,
  ProjectCanvasData,
  Requirement,
  RequirementClarification,
  RequirementConversation,
  ConversationEvent,
  StreamEvent,
} from "../types/api";
import {
  createRequirement,
  appendRequirementMessage,
  getRequirementConversation,
  retryRequirementAnalysis,
  submitRequirementClarifications,
  confirmRequirement,
  requirementConversationWebSocketUrl,
} from "../api/client";
import { readError, buildClarificationAnswerPayload } from "../utils/format";
import { useConversationSocket } from "./useConversationSocket";

function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requirement_id === "string" &&
    typeof record.event === "string" &&
    typeof record.message === "string"
  );
}

export function useRequirementFlow(
  selectedProjectId: string | null,
  activeRequirementId: string | null,
  observedRequirementId: string | null,
  setProjectCanvas: (data: ProjectCanvasData) => void,
  loadProjectCanvas: (
    projectId: string,
    dagRequirementId?: string | null,
  ) => Promise<ProjectCanvasData>,
  observeRequirement: (requirementId: string) => void,
) {
  const [requirementInput, setRequirementInput] = useState("");
  const [requirementReferences, setRequirementReferences] = useState<
    FileReference[]
  >([]);
  const [requirementImages, setRequirementImages] = useState<ImageAttachment[]>(
    [],
  );
  const [requirementBusy, setRequirementBusy] = useState(false);
  const [requirementError, setRequirementError] = useState<string | null>(null);
  const [requirementStreamEvents, setRequirementStreamEvents] = useState<
    StreamEvent[]
  >([]);
  const requirementEventBufferRef = useRef<StreamEvent[]>([]);
  const requirementFlushTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [requirementConversation, setRequirementConversation] =
    useState<RequirementConversation | null>(null);
  const [dismissedPromptRequirementId, setDismissedPromptRequirementId] =
    useState<string | null>(null);
  const [clarificationAnswers, setClarificationAnswers] = useState<
    Record<string, DraftClarificationAnswer>
  >({});

  const loadRequirementConversation = useCallback(
    async (requirementId: string) => {
      const data = await getRequirementConversation(requirementId);
      setRequirementConversation(data);
      return data;
    },
    [],
  );

  useEffect(() => {
    setRequirementStreamEvents([]);
    setClarificationAnswers({});
    setDismissedPromptRequirementId(null);
    if (!activeRequirementId) setRequirementConversation(null);
  }, [activeRequirementId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setRequirementInput("");
      setRequirementReferences([]);
      setRequirementImages([]);
      setRequirementError(null);
      setRequirementStreamEvents([]);
      setRequirementConversation(null);
      setDismissedPromptRequirementId(null);
      setClarificationAnswers({});
    }
  }, [selectedProjectId]);

  useEffect(() => {
    setRequirementStreamEvents([]);
  }, [observedRequirementId]);

  const sendRequirementMessage = useCallback(async () => {
    const message = requirementInput.trim();
    if (!message || !selectedProjectId) {
      return;
    }

    setRequirementBusy(true);
    setRequirementError(null);
    try {
      const accepted = activeRequirementId
        ? await appendRequirementMessage(activeRequirementId, {
            message,
            references: requirementReferences,
            images: requirementImages,
          })
        : await createRequirement(selectedProjectId, {
            message,
            references: requirementReferences,
            images: requirementImages,
          });
      setRequirementStreamEvents([]);
      setClarificationAnswers({});
      setDismissedPromptRequirementId(null);
      const data = await loadProjectCanvas(selectedProjectId);
      setProjectCanvas(data);
      const nextRequirementId =
        data.active_requirement?.id ?? accepted.requirement_id;
      void loadRequirementConversation(nextRequirementId).catch((reason) =>
        setRequirementError(readError(reason)),
      );
      setRequirementInput("");
      setRequirementReferences([]);
      setRequirementImages([]);
    } catch (reason) {
      setRequirementError(readError(reason));
    } finally {
      setRequirementBusy(false);
    }
  }, [
    activeRequirementId,
    loadRequirementConversation,
    loadProjectCanvas,
    requirementInput,
    requirementImages,
    requirementReferences,
    selectedProjectId,
    setProjectCanvas,
  ]);

  const handleConversationEvent = useCallback(
    (event: ConversationEvent) => {
      if (!activeRequirementId) return;
      const eventRequirementId = event.payload.requirement_id;
      if (
        typeof eventRequirementId === "string" &&
        eventRequirementId !== activeRequirementId
      ) {
        return;
      }
      if (event.type === "session.error") {
        setRequirementError(
          typeof event.payload.message === "string"
            ? event.payload.message
            : "需求分析失败",
        );
      }
      setRequirementStreamEvents((current) => [
        ...current,
        conversationEventToStreamEvent(activeRequirementId, event),
      ]);
    },
    [activeRequirementId],
  );

  useConversationSocket({
    url: activeRequirementId
      ? requirementConversationWebSocketUrl(activeRequirementId)
      : null,
    loadSnapshot: useCallback(() => {
      if (!activeRequirementId) throw new Error("需求未加载");
      return getRequirementConversation(activeRequirementId);
    }, [activeRequirementId]),
    onSnapshot: useCallback((snapshot: RequirementConversation) => {
      setRequirementConversation(snapshot);
      setRequirementError(snapshot.error);
      setRequirementStreamEvents([]);
    }, []),
    onEvent: handleConversationEvent,
    onError: setRequirementError,
  });

  const updateClarificationAnswer = useCallback(
    (
      clarification: RequirementClarification,
      answer: DraftClarificationAnswer,
    ) => {
      setClarificationAnswers((current) => ({
        ...current,
        [clarification.id]: answer,
      }));
    },
    [],
  );

  const submitClarifications = useCallback(
    async (requirement: Requirement) => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const answers = requirement.clarifications.map((clarification) =>
          buildClarificationAnswerPayload(
            clarification,
            clarificationAnswers[clarification.id] ?? {
              selectedOptions: clarification.answer?.selected_options ?? [],
              customText: clarification.answer?.custom_text ?? "",
            },
          ),
        );
        const prompt =
          requirementConversation?.prompt?.type === "clarification"
            ? requirementConversation.prompt
            : undefined;
        const data = await submitRequirementClarifications(
          requirement.id,
          answers,
          prompt,
        );
        setRequirementStreamEvents([]);
        setClarificationAnswers({});
        setDismissedPromptRequirementId(null);
        setProjectCanvas(data);
        if (data.active_requirement) {
          void loadRequirementConversation(data.active_requirement.id).catch(
            (reason) => setRequirementError(readError(reason)),
          );
        }
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementBusy(false);
      }
    },
    [
      clarificationAnswers,
      loadRequirementConversation,
      requirementConversation?.prompt,
      setProjectCanvas,
    ],
  );

  const confirm = useCallback(
    async (requirement: Requirement) => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const prompt =
          requirementConversation?.prompt?.type === "confirmation"
            ? requirementConversation.prompt
            : undefined;
        const data = await confirmRequirement(requirement.id, prompt);
        setDismissedPromptRequirementId(null);
        setProjectCanvas(data);
        observeRequirement(requirement.id);
        if (data.active_requirement) {
          void loadRequirementConversation(data.active_requirement.id).catch(
            (reason) => setRequirementError(readError(reason)),
          );
        } else {
          setRequirementConversation(null);
        }
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementBusy(false);
      }
    },
    [
      loadRequirementConversation,
      observeRequirement,
      requirementConversation?.prompt,
      setProjectCanvas,
    ],
  );

  const retryAnalysis = useCallback(
    async (requirement: Requirement) => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const data = await retryRequirementAnalysis(requirement.id);
        setProjectCanvas(data);
        observeRequirement(requirement.id);
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementBusy(false);
      }
    },
    [observeRequirement, setProjectCanvas],
  );

  const continueEditingRequirement = useCallback((requirement: Requirement) => {
    setDismissedPromptRequirementId(requirement.id);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>(
          '[data-chat-card="requirement"] textarea:not(:disabled)',
        )
        ?.focus();
    });
  }, []);

  useEffect(() => {
    if (
      !observedRequirementId ||
      !selectedProjectId ||
      observedRequirementId === activeRequirementId
    ) {
      requirementEventBufferRef.current = [];
      if (requirementFlushTimeoutRef.current !== null) {
        clearTimeout(requirementFlushTimeoutRef.current);
        requirementFlushTimeoutRef.current = null;
      }
      return;
    }

    const dagSummaryMode = true;
    const canvasRefreshEvents = new Set([
      "clarifications_ready",
      "draft_ready",
      "execution_plan_ready",
      "execution_plan_failed",
      "execution_started",
      "execution_task_started",
      "execution_task_completed",
      "execution_task_failed",
      "execution_task_retrying",
      "execution_task_guided",
      "execution_completed",
      "execution_failed",
    ]);

    const flushRequirementEvents = () => {
      requirementFlushTimeoutRef.current = null;
      const batch = requirementEventBufferRef.current;
      if (batch.length === 0) return;
      requirementEventBufferRef.current = [];
      if (batch.some((event) => canvasRefreshEvents.has(event.event))) {
        void loadProjectCanvas(
          selectedProjectId,
          dagSummaryMode ? observedRequirementId : null,
        ).catch((reason) => setRequirementError(readError(reason)));
      }
    };

    const scheduleRequirementFlush = () => {
      if (requirementFlushTimeoutRef.current !== null) return;
      requirementFlushTimeoutRef.current = setTimeout(
        flushRequirementEvents,
        50,
      );
    };

    const source = new EventSource(
      `/api/requirements/${encodeURIComponent(observedRequirementId)}/events${
        dagSummaryMode ? "?include_pi_events=false" : ""
      }`,
    );

    const handleEvent = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data);
        if (!isStreamEvent(parsed)) {
          console.error("Invalid EventSource payload", parsed);
          return;
        }
        if (parsed.requirement_id !== observedRequirementId) {
          return;
        }
        if (dagSummaryMode && parsed.event === "pi_event") {
          return;
        }
        requirementEventBufferRef.current.push(parsed);
        scheduleRequirementFlush();
      } catch (error) {
        console.error("EventSource message parse error", error, event.data);
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
      "analysis_cancelled",
      "coordinator_time_warning",
      "execution_planning_started",
      "execution_plan_ready",
      "execution_plan_failed",
      "execution_started",
      "execution_task_started",
      "execution_task_completed",
      "execution_task_failed",
      "execution_task_retrying",
      "execution_task_guided",
      "execution_completed",
      "execution_failed",
    ]) {
      source.addEventListener(eventName, handleEvent);
    }

    return () => {
      if (requirementFlushTimeoutRef.current !== null) {
        clearTimeout(requirementFlushTimeoutRef.current);
        requirementFlushTimeoutRef.current = null;
      }
      requirementEventBufferRef.current = [];
      source.close();
    };
  }, [
    activeRequirementId,
    loadProjectCanvas,
    observedRequirementId,
    selectedProjectId,
  ]);

  return {
    requirementInput,
    setRequirementInput,
    requirementReferences,
    setRequirementReferences,
    requirementImages,
    setRequirementImages,
    requirementBusy,
    requirementError,
    requirementStreamEvents,
    requirementConversation,
    dismissedPromptRequirementId,
    clarificationAnswers,
    updateClarificationAnswer,
    submitClarifications,
    sendRequirementMessage,
    confirmRequirement: confirm,
    retryRequirementAnalysis: retryAnalysis,
    continueEditingRequirement,
  };
}

function conversationEventToStreamEvent(
  requirementId: string,
  event: ConversationEvent,
): StreamEvent {
  const message =
    typeof event.payload.message === "string"
      ? event.payload.message
      : typeof event.payload.delta === "string"
        ? event.payload.delta
        : "";
  return {
    requirement_id: requirementId,
    event:
      event.type.startsWith("assistant.") || event.type.startsWith("tool.")
        ? "pi_event"
        : event.type,
    message,
    pi_type:
      typeof event.payload.pi_type === "string"
        ? event.payload.pi_type
        : undefined,
    payload: event.payload.event ?? event.payload.payload ?? event.payload,
  };
}
