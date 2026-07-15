import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatSubmission,
  DraftClarificationAnswer,
  FileReference,
  ImageAttachment,
  ProjectCanvasData,
  Requirement,
  RequirementConversation,
  ConversationEvent,
  StreamEvent,
} from "../types/api";
import {
  createRequirementBranch,
  appendRequirementMessage,
  getRequirementConversation,
  retryRequirementAnalysis,
  submitRequirementClarifications,
  confirmRequirement,
  requirementConversationWebSocketUrl,
} from "../api/client";
import { readError, buildClarificationAnswerPayload } from "../utils/format";
import { useConversationSocket } from "./useConversationSocket";

const EMPTY_REQUIREMENTS: Requirement[] = [];

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
  activeRequirementId: string | null,
  observedRequirementId: string | null,
  setProjectCanvas: (data: ProjectCanvasData) => void,
  loadProjectCanvas: (
    workflowRequirementId?: string | null,
  ) => Promise<ProjectCanvasData>,
  observeRequirement: (requirementId: string) => void,
  allRequirements: Requirement[] = EMPTY_REQUIREMENTS,
) {
  const [requirementBusy, setRequirementBusy] = useState(false);
  const [openingRequirementId, setOpeningRequirementId] = useState<
    string | null
  >(null);
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
  const requirementConversationRef = useRef(requirementConversation);
  requirementConversationRef.current = requirementConversation;
  const [dismissedPromptRequirementId, setDismissedPromptRequirementId] =
    useState<string | null>(null);
  const requestedConversationRef = useRef<string | null>(null);

  const conversationRequirementId = activeRequirementId ?? openingRequirementId;

  const loadRequirementConversation = useCallback(
    async (requirementId: string) => {
      requestedConversationRef.current = requirementId;
      try {
        const data = await getRequirementConversation(requirementId);
        setRequirementConversation(data);
        setRequirementError((current) => (data.error ? data.error : current));
        return data;
      } catch (reason) {
        const message = readError(reason);
        setRequirementError(message);
        throw reason;
      }
    },
    [],
  );

  useEffect(() => {
    setRequirementStreamEvents([]);
    setDismissedPromptRequirementId(null);
    setRequirementError(null);
    setRequirementConversation(null);
    requestedConversationRef.current = null;
    if (!conversationRequirementId) return;
    void loadRequirementConversation(conversationRequirementId).catch(() => {});
  }, [conversationRequirementId, loadRequirementConversation]);

  useEffect(() => {
    if (
      openingRequirementId &&
      allRequirements.some(
        (requirement) => requirement.id === openingRequirementId,
      )
    ) {
      setOpeningRequirementId(null);
    }
  }, [allRequirements, openingRequirementId]);

  useEffect(() => {
    setRequirementStreamEvents([]);
  }, [observedRequirementId]);

  const startRequirement = useCallback(
    async (
      description: string,
      attachments: {
        references: FileReference[];
        images: ImageAttachment[];
      },
    ): Promise<boolean> => {
      const message = description.trim() || "基于上文整理需求";

      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const accepted = await createRequirementBranch({
          message,
          references: attachments.references,
          images: attachments.images,
        });
        setOpeningRequirementId(accepted.requirement_id);
        setRequirementStreamEvents([]);
        setDismissedPromptRequirementId(null);

        try {
          const data = await loadProjectCanvas();
          setProjectCanvas(data);
        } catch (reason) {
          setRequirementError(readError(reason));
        }
        return true;
      } catch (reason) {
        setRequirementError(readError(reason));
        return false;
      } finally {
        setRequirementBusy(false);
      }
    },
    [loadProjectCanvas, setProjectCanvas],
  );

  const sendRequirementMessage = useCallback(
    async (payload: ChatSubmission) => {
      const message = payload.message.trim();
      if (!message || !activeRequirementId) {
        return false;
      }

      setRequirementBusy(true);
      setRequirementError(null);
      try {
        await appendRequirementMessage(activeRequirementId, {
          message,
          references: payload.references,
          images: payload.images,
        });
        setRequirementStreamEvents([]);
        setDismissedPromptRequirementId(null);
        const data = await loadProjectCanvas();
        setProjectCanvas(data);
        return true;
      } catch (reason) {
        setRequirementError(readError(reason));
        return false;
      } finally {
        setRequirementBusy(false);
      }
    },
    [activeRequirementId, loadProjectCanvas, setProjectCanvas],
  );

  const handleConversationEvent = useCallback(
    (event: ConversationEvent) => {
      if (!conversationRequirementId) return;
      const eventRequirementId = event.payload.requirement_id;
      if (
        typeof eventRequirementId === "string" &&
        eventRequirementId !== conversationRequirementId
      ) {
        return;
      }
      if (event.type === "session.error") {
        const message =
          typeof event.payload.message === "string"
            ? event.payload.message
            : "需求分析失败";
        setRequirementError(message);
      }
      setRequirementStreamEvents((current) => [
        ...current,
        conversationEventToStreamEvent(conversationRequirementId, event),
      ]);
    },
    [conversationRequirementId],
  );

  useConversationSocket({
    url: conversationRequirementId
      ? requirementConversationWebSocketUrl(conversationRequirementId)
      : null,
    loadSnapshot: useCallback(() => {
      if (!conversationRequirementId) throw new Error("需求未加载");
      return getRequirementConversation(conversationRequirementId);
    }, [conversationRequirementId]),
    onSnapshot: useCallback((snapshot: RequirementConversation) => {
      setRequirementConversation(snapshot);
      setRequirementError((current) =>
        snapshot.error ? snapshot.error : current,
      );
      setRequirementStreamEvents((current) =>
        snapshot.running ? current : [],
      );
    }, []),
    onEvent: handleConversationEvent,
    onError: useCallback((message: string) => {
      setRequirementError(message);
    }, []),
  });

  const submitClarifications = useCallback(
    async (
      requirement: Requirement,
      clarificationAnswers: Record<string, DraftClarificationAnswer>,
    ): Promise<boolean> => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const prompt = requirementConversationRef.current?.prompt;
        if (!prompt || prompt.type !== "clarification") {
          throw new Error("当前需求没有可提交的澄清提示");
        }
        const sourceClarifications =
          prompt?.questions ?? requirement.clarifications;
        const answers = sourceClarifications.map((clarification) =>
          buildClarificationAnswerPayload(
            clarification,
            clarificationAnswers[clarification.id] ?? {
              selectedOptions: clarification.answer?.selected_options ?? [],
              customText: clarification.answer?.custom_text ?? "",
            },
          ),
        );
        const data = await submitRequirementClarifications(
          requirement.id,
          answers,
          prompt,
        );
        setRequirementStreamEvents([]);
        setDismissedPromptRequirementId(null);
        setProjectCanvas(data);
        if (data.active_requirement) {
          void loadRequirementConversation(data.active_requirement.id).catch(
            (reason) => setRequirementError(readError(reason)),
          );
        }
        return true;
      } catch (reason) {
        setRequirementError(readError(reason));
        return false;
      } finally {
        setRequirementBusy(false);
      }
    },
    [loadRequirementConversation, setProjectCanvas],
  );

  const confirm = useCallback(
    async (requirement: Requirement) => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const prompt = requirementConversationRef.current?.prompt;
        if (!prompt || prompt.type !== "confirmation") {
          throw new Error("当前需求没有可确认的规格提示");
        }
        const data = await confirmRequirement(requirement.id, prompt);
        setDismissedPromptRequirementId(null);
        setProjectCanvas(data);
        observeRequirement(requirement.id);
        void loadRequirementConversation(requirement.id).catch((reason) =>
          setRequirementError(readError(reason)),
        );
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
    [loadRequirementConversation, observeRequirement, setProjectCanvas],
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
  }, []);

  useEffect(() => {
    if (
      !observedRequirementId ||
      observedRequirementId === activeRequirementId
    ) {
      requirementEventBufferRef.current = [];
      if (requirementFlushTimeoutRef.current !== null) {
        clearTimeout(requirementFlushTimeoutRef.current);
        requirementFlushTimeoutRef.current = null;
      }
      return;
    }

    const workflowSummaryMode = true;
    const canvasRefreshEvents = new Set([
      "clarifications_ready",
      "draft_ready",
      "change_spec_repair_started",
      "change_spec_repair_completed",
      "change_spec_repair_failed",
      "workflow_planning_preflight_failed",
      "workflow_plan_ready",
      "workflow_plan_failed",
      "workflow_started",
      "work_item_fix_scheduled",
      "work_item_attempt_started",
      "work_item_attempt_failed",
      "work_item_ready",
      "work_item_validation_failed",
      "checkpoint_review_started",
      "checkpoint_review_retry",
      "stage_checkpoint_approved",
      "workflow_rescue_started",
      "workflow_rescue_completed",
      "workflow_completed",
      "workflow_blocked",
    ]);

    const flushRequirementEvents = () => {
      requirementFlushTimeoutRef.current = null;
      const batch = requirementEventBufferRef.current;
      if (batch.length === 0) return;
      requirementEventBufferRef.current = [];
      if (batch.some((event) => canvasRefreshEvents.has(event.event))) {
        void loadProjectCanvas(
          workflowSummaryMode ? observedRequirementId : null,
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
        workflowSummaryMode ? "?include_pi_events=false" : ""
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
        if (workflowSummaryMode && parsed.event === "pi_event") {
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
      "change_spec_repair_started",
      "change_spec_repair_completed",
      "change_spec_repair_failed",
      "workflow_planning_started",
      "workflow_plan_ready",
      "workflow_plan_failed",
      "workflow_started",
      "work_item_fix_scheduled",
      "work_item_attempt_started",
      "work_item_attempt_failed",
      "work_item_ready",
      "work_item_validation_failed",
      "checkpoint_review_started",
      "checkpoint_review_retry",
      "stage_checkpoint_approved",
      "workflow_rescue_started",
      "workflow_rescue_completed",
      "workflow_completed",
      "workflow_blocked",
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
  }, [activeRequirementId, loadProjectCanvas, observedRequirementId]);

  return {
    requirementBusy,
    openingRequirementId,
    requirementError,
    requirementStreamEvents,
    requirementConversation,
    dismissedPromptRequirementId,
    submitClarifications,
    startRequirement,
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
    typeof event.payload.message === "string" ? event.payload.message : "";
  return {
    requirement_id: requirementId,
    event: event.type,
    message,
    pi_type:
      typeof event.payload.pi_type === "string"
        ? event.payload.pi_type
        : undefined,
    payload: event.payload.event ?? event.payload,
  };
}
