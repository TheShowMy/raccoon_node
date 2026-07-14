import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatSubmission,
  DraftClarificationAnswer,
  FileReference,
  ImageAttachment,
  ProjectCanvasData,
  Requirement,
  RequirementConversation,
  RequirementTimelineBranch,
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
  selectedProjectId: string | null,
  activeRequirementId: string | null,
  observedRequirementId: string | null,
  setProjectCanvas: (data: ProjectCanvasData) => void,
  loadProjectCanvas: (
    projectId: string,
    workflowRequirementId?: string | null,
  ) => Promise<ProjectCanvasData>,
  observeRequirement: (requirementId: string) => void,
  allRequirements: Requirement[] = EMPTY_REQUIREMENTS,
) {
  const [requirementBusy, setRequirementBusy] = useState(false);
  const [openingRequirementId, setOpeningRequirementId] = useState<
    string | null
  >(null);
  const [openingRequirementCreatedAt, setOpeningRequirementCreatedAt] =
    useState<string | null>(null);
  const [requirementError, setRequirementError] = useState<string | null>(null);
  const [requirementStreamEvents, setRequirementStreamEvents] = useState<
    StreamEvent[]
  >([]);
  const requirementEventBufferRef = useRef<StreamEvent[]>([]);
  const requirementFlushTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [requirementConversations, setRequirementConversations] = useState<
    Record<string, RequirementConversation>
  >({});
  const requirementConversationsRef = useRef(requirementConversations);
  requirementConversationsRef.current = requirementConversations;
  const [conversationErrors, setConversationErrors] = useState<
    Record<string, string>
  >({});
  const [conversationLoading, setConversationLoading] = useState<
    Record<string, boolean>
  >({});
  const requestedConversationsRef = useRef(new Set<string>());
  const historyLoadPromiseRef = useRef<Promise<boolean> | null>(null);
  const timelineBranchesRef = useRef(
    new Map<string, RequirementTimelineBranch>(),
  );
  const [dismissedPromptRequirementId, setDismissedPromptRequirementId] =
    useState<string | null>(null);

  const loadRequirementConversation = useCallback(
    async (requirementId: string, force = false) => {
      if (!force && requestedConversationsRef.current.has(requirementId)) {
        return requirementConversationsRef.current[requirementId] ?? null;
      }
      requestedConversationsRef.current.add(requirementId);
      setConversationLoading((current) => ({
        ...current,
        [requirementId]: true,
      }));
      setConversationErrors((current) => {
        if (!(requirementId in current)) return current;
        const next = { ...current };
        delete next[requirementId];
        return next;
      });
      try {
        const data = await getRequirementConversation(requirementId);
        setRequirementConversations((current) => ({
          ...current,
          [requirementId]: data,
        }));
        return data;
      } catch (reason) {
        const message = readError(reason);
        setConversationErrors((current) => ({
          ...current,
          [requirementId]: message,
        }));
        throw reason;
      } finally {
        setConversationLoading((current) => ({
          ...current,
          [requirementId]: false,
        }));
      }
    },
    [],
  );

  const conversationRequirementId = activeRequirementId ?? openingRequirementId;
  const requirementConversation = conversationRequirementId
    ? (requirementConversations[conversationRequirementId] ?? null)
    : null;
  const requirementConversationRef = useRef(requirementConversation);
  requirementConversationRef.current = requirementConversation;

  useEffect(() => {
    setRequirementStreamEvents([]);
    setDismissedPromptRequirementId(null);
    setRequirementError(null);
  }, [conversationRequirementId]);

  useEffect(() => {
    if (
      openingRequirementId &&
      allRequirements.some(
        (requirement) => requirement.id === openingRequirementId,
      )
    ) {
      setOpeningRequirementId(null);
      setOpeningRequirementCreatedAt(null);
    }
  }, [allRequirements, openingRequirementId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setRequirementError(null);
      setOpeningRequirementId(null);
      setOpeningRequirementCreatedAt(null);
      setRequirementStreamEvents([]);
      setRequirementConversations({});
      setConversationErrors({});
      setConversationLoading({});
      requestedConversationsRef.current.clear();
      setDismissedPromptRequirementId(null);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    const retainedIds = new Set(allRequirements.map(({ id }) => id));
    if (activeRequirementId) retainedIds.add(activeRequirementId);
    if (openingRequirementId) retainedIds.add(openingRequirementId);
    const retain = <T>(current: Record<string, T>) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([id]) => retainedIds.has(id)),
      ) as Record<string, T>;
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      return currentKeys.length === nextKeys.length &&
        currentKeys.every((key) => key in next)
        ? current
        : next;
    };
    setRequirementConversations(retain);
    setConversationErrors(retain);
    setConversationLoading(retain);
    for (const id of requestedConversationsRef.current) {
      if (!retainedIds.has(id)) requestedConversationsRef.current.delete(id);
    }
  }, [activeRequirementId, allRequirements, openingRequirementId]);

  const orderedRequirementIds = useMemo(
    () =>
      [...allRequirements]
        .sort(
          (left, right) =>
            Date.parse(right.created_at) - Date.parse(left.created_at),
        )
        .map((requirement) => requirement.id),
    [allRequirements],
  );

  const isConversationSettled = useCallback(
    (requirementId: string) =>
      requirementId === conversationRequirementId ||
      Boolean(
        requirementConversations[requirementId] ||
        conversationErrors[requirementId] ||
        conversationLoading[requirementId],
      ),
    [
      conversationErrors,
      conversationLoading,
      conversationRequirementId,
      requirementConversations,
    ],
  );

  useEffect(() => {
    const newestHistoricalId = orderedRequirementIds.find(
      (requirementId) => requirementId !== conversationRequirementId,
    );
    if (!newestHistoricalId || isConversationSettled(newestHistoricalId)) {
      return;
    }
    void loadRequirementConversation(newestHistoricalId).catch(() => {});
  }, [
    conversationRequirementId,
    isConversationSettled,
    loadRequirementConversation,
    orderedRequirementIds,
  ]);

  const hasOlderRequirementHistory = orderedRequirementIds.some(
    (requirementId) => !isConversationSettled(requirementId),
  );

  const loadOlderRequirementHistory = useCallback(async () => {
    if (historyLoadPromiseRef.current) {
      return historyLoadPromiseRef.current;
    }
    const nextId = orderedRequirementIds.find(
      (requirementId) => !isConversationSettled(requirementId),
    );
    if (!nextId) return false;
    const promise = (async () => {
      try {
        await loadRequirementConversation(nextId);
        return true;
      } catch {
        return false;
      } finally {
        historyLoadPromiseRef.current = null;
      }
    })();
    historyLoadPromiseRef.current = promise;
    return promise;
  }, [
    isConversationSettled,
    loadRequirementConversation,
    orderedRequirementIds,
  ]);

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
      if (!selectedProjectId) return false;
      const message = description.trim() || "基于上文整理需求";

      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const accepted = await createRequirementBranch(selectedProjectId, {
          message,
          references: attachments.references,
          images: attachments.images,
        });
        setOpeningRequirementId(accepted.requirement_id);
        setOpeningRequirementCreatedAt(new Date().toISOString());
        setRequirementStreamEvents([]);
        setDismissedPromptRequirementId(null);

        try {
          const data = await loadProjectCanvas(selectedProjectId);
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
    [loadProjectCanvas, selectedProjectId, setProjectCanvas],
  );

  const sendRequirementMessage = useCallback(
    async (payload: ChatSubmission) => {
      const message = payload.message.trim();
      if (!message || !selectedProjectId || !activeRequirementId) {
        return false;
      }

      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const accepted = await appendRequirementMessage(activeRequirementId, {
          message,
          references: payload.references,
          images: payload.images,
        });
        setRequirementStreamEvents([]);
        setDismissedPromptRequirementId(null);
        const data = await loadProjectCanvas(selectedProjectId);
        setProjectCanvas(data);
        const nextRequirementId =
          data.active_requirement?.id ?? accepted.requirement_id;
        void loadRequirementConversation(nextRequirementId, true).catch(
          (reason) => setRequirementError(readError(reason)),
        );
        return true;
      } catch (reason) {
        setRequirementError(readError(reason));
        return false;
      } finally {
        setRequirementBusy(false);
      }
    },
    [
      activeRequirementId,
      loadRequirementConversation,
      loadProjectCanvas,
      selectedProjectId,
      setProjectCanvas,
    ],
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
        setConversationErrors((current) => ({
          ...current,
          [conversationRequirementId]: message,
        }));
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
      requestedConversationsRef.current.add(conversationRequirementId);
      return getRequirementConversation(conversationRequirementId);
    }, [conversationRequirementId]),
    onSnapshot: useCallback((snapshot: RequirementConversation) => {
      setRequirementConversations((current) => ({
        ...current,
        [snapshot.id]: snapshot,
      }));
      setConversationErrors((current) => {
        if (!current[snapshot.id] && !snapshot.error) return current;
        const next = { ...current };
        if (snapshot.error) next[snapshot.id] = snapshot.error;
        else delete next[snapshot.id];
        return next;
      });
      setRequirementError(snapshot.error);
      setRequirementStreamEvents((current) =>
        snapshot.running ? current : [],
      );
    }, []),
    onEvent: handleConversationEvent,
    onError: useCallback(
      (message: string) => {
        setRequirementError(message);
        if (!conversationRequirementId) return;
        setConversationErrors((current) => ({
          ...current,
          [conversationRequirementId]: message,
        }));
      },
      [conversationRequirementId],
    ),
  });

  const submitClarifications = useCallback(
    async (
      requirement: Requirement,
      clarificationAnswers: Record<string, DraftClarificationAnswer>,
    ): Promise<boolean> => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const currentConversation = requirementConversationRef.current;
        const prompt =
          currentConversation?.prompt?.type === "clarification"
            ? currentConversation.prompt
            : undefined;
        // 使用 prompt.questions（用户实际看到的问题）作为答案来源，避免
        // requirement.clarifications 与 conversation snapshot 不同步导致首次
        // 提交空数组。
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
          void loadRequirementConversation(
            data.active_requirement.id,
            true,
          ).catch((reason) => setRequirementError(readError(reason)));
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
        const currentConversation = requirementConversationRef.current;
        const prompt =
          currentConversation?.prompt?.type === "confirmation"
            ? currentConversation.prompt
            : undefined;
        const data = await confirmRequirement(requirement.id, prompt);
        setDismissedPromptRequirementId(null);
        setProjectCanvas(data);
        observeRequirement(requirement.id);
        void loadRequirementConversation(requirement.id, true).catch((reason) =>
          setRequirementError(readError(reason)),
        );
        if (data.active_requirement) {
          void loadRequirementConversation(
            data.active_requirement.id,
            true,
          ).catch((reason) => setRequirementError(readError(reason)));
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
          selectedProjectId,
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
      "workflow_planning_preflight_failed",
      "coordinator_time_warning",
      "coordinator_token_budget_warning",
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
  }, [
    activeRequirementId,
    loadProjectCanvas,
    observedRequirementId,
    selectedProjectId,
  ]);

  const requirementTimeline = useMemo<RequirementTimelineBranch[]>(() => {
    const requirementsById = new Map(
      allRequirements.map((requirement) => [requirement.id, requirement]),
    );
    const requirementIds = [...requirementsById.keys()];
    if (openingRequirementId && !requirementsById.has(openingRequirementId)) {
      requirementIds.push(openingRequirementId);
    }
    const nextBranches = new Map<string, RequirementTimelineBranch>();
    const branches = requirementIds.map((requirementId) => {
      const requirement = requirementsById.get(requirementId) ?? null;
      const conversation = requirementConversations[requirementId] ?? null;
      const branch: RequirementTimelineBranch = {
        requirementId,
        requirement,
        conversation,
        loading: Boolean(conversationLoading[requirementId]),
        error: conversationErrors[requirementId] ?? null,
        createdAt:
          requirement?.created_at ??
          conversation?.items[0]?.created_at ??
          openingRequirementCreatedAt ??
          conversation?.updated_at ??
          new Date(0).toISOString(),
        opening: openingRequirementId === requirementId,
      };
      const previous = timelineBranchesRef.current.get(requirementId);
      const stable =
        previous &&
        previous.requirement === branch.requirement &&
        previous.conversation === branch.conversation &&
        previous.loading === branch.loading &&
        previous.error === branch.error &&
        previous.createdAt === branch.createdAt &&
        previous.opening === branch.opening
          ? previous
          : branch;
      nextBranches.set(requirementId, stable);
      return stable;
    });
    timelineBranchesRef.current = nextBranches;
    return branches;
  }, [
    allRequirements,
    conversationErrors,
    conversationLoading,
    openingRequirementCreatedAt,
    openingRequirementId,
    requirementConversations,
  ]);

  return {
    requirementBusy,
    openingRequirementId,
    requirementError,
    requirementStreamEvents,
    requirementConversation,
    requirementTimeline,
    hasOlderRequirementHistory,
    loadOlderRequirementHistory,
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
