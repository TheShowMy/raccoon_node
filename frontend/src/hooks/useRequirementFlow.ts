import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DraftClarificationAnswer,
  FileReference,
  ImageAttachment,
  ProjectCanvasData,
  Requirement,
  RequirementClarification,
  RequirementConversation,
  StreamEvent,
} from "../types/api";
import {
  createRequirement,
  appendRequirementMessage,
  getRequirementConversation,
  retryRequirementAnalysis,
  submitRequirementClarifications,
  confirmRequirement,
} from "../api/client";
import { readError, buildClarificationAnswerPayload } from "../utils/format";

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
  loadProjectCanvas: (projectId: string) => Promise<ProjectCanvasData>,
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
    if (activeRequirementId) {
      void loadRequirementConversation(activeRequirementId).catch((reason) =>
        setRequirementError(readError(reason)),
      );
      return;
    }
    setRequirementConversation(null);
  }, [activeRequirementId, loadRequirementConversation]);

  useEffect(() => {
    if (!selectedProjectId) {
      setRequirementInput("");
      setRequirementReferences([]);
      setRequirementImages([]);
      setRequirementError(null);
      setRequirementStreamEvents([]);
      setRequirementConversation(null);
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
      const data = activeRequirementId
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
      setProjectCanvas(data);
      if (data.active_requirement) {
        void loadRequirementConversation(data.active_requirement.id).catch(
          (reason) => setRequirementError(readError(reason)),
        );
      } else {
        setRequirementConversation(null);
      }
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
    requirementInput,
    requirementImages,
    requirementReferences,
    selectedProjectId,
    setProjectCanvas,
  ]);

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

  const continueEditingRequirement = useCallback(
    (_requirement: Requirement) => {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLTextAreaElement>(
            '[data-chat-card="requirement"] textarea:not(:disabled)',
          )
          ?.focus();
      });
    },
    [],
  );

  useEffect(() => {
    if (!observedRequirementId || !selectedProjectId) {
      requirementEventBufferRef.current = [];
      if (requirementFlushTimeoutRef.current !== null) {
        clearTimeout(requirementFlushTimeoutRef.current);
        requirementFlushTimeoutRef.current = null;
      }
      return;
    }

    const transientEvents = new Set([
      "coordinator_started",
      "coordinator_progress",
      "coordinator_time_warning",
      "pi_event",
    ]);
    const canvasRefreshEvents = new Set([
      "clarifications_ready",
      "draft_ready",
    ]);

    const flushRequirementEvents = () => {
      requirementFlushTimeoutRef.current = null;
      const batch = requirementEventBufferRef.current;
      if (batch.length === 0) return;
      requirementEventBufferRef.current = [];
      setRequirementStreamEvents((current) => [...current, ...batch]);

      if (batch.some((event) => !transientEvents.has(event.event))) {
        void loadRequirementConversation(observedRequirementId).catch(
          (reason) => setRequirementError(readError(reason)),
        );
      }
      if (batch.some((event) => canvasRefreshEvents.has(event.event))) {
        void loadProjectCanvas(selectedProjectId).catch((reason) =>
          setRequirementError(readError(reason)),
        );
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
      `/api/requirements/${encodeURIComponent(observedRequirementId)}/events`,
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
    loadRequirementConversation,
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
    dismissedPromptRequirementId: null,
    clarificationAnswers,
    updateClarificationAnswer,
    submitClarifications,
    sendRequirementMessage,
    confirmRequirement: confirm,
    retryRequirementAnalysis: retryAnalysis,
    continueEditingRequirement,
  };
}
