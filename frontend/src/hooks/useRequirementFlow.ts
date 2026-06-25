import { useCallback, useEffect, useState } from "react";
import type {
  DraftClarificationAnswer,
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
  const [requirementBusy, setRequirementBusy] = useState(false);
  const [requirementError, setRequirementError] = useState<string | null>(null);
  const [requirementStreamEvents, setRequirementStreamEvents] = useState<
    StreamEvent[]
  >([]);
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
      const data = activeRequirementId
        ? await appendRequirementMessage(activeRequirementId, message)
        : await createRequirement(selectedProjectId, message);
      setRequirementStreamEvents([]);
      setClarificationAnswers({});
      setDismissedPromptRequirementId(null);
      setProjectCanvas(data);
      if (data.active_requirement) {
        void loadRequirementConversation(data.active_requirement.id).catch(
          (reason) => setRequirementError(readError(reason)),
        );
      } else {
        setRequirementConversation(null);
      }
      setRequirementInput("");
    } catch (reason) {
      setRequirementError(readError(reason));
    } finally {
      setRequirementBusy(false);
    }
  }, [
    activeRequirementId,
    loadRequirementConversation,
    requirementInput,
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
        const data = await submitRequirementClarifications(
          requirement.id,
          answers,
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
    [clarificationAnswers, loadRequirementConversation, setProjectCanvas],
  );

  const confirm = useCallback(
    async (requirement: Requirement) => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const data = await confirmRequirement(requirement.id);
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
    [loadRequirementConversation, observeRequirement, setProjectCanvas],
  );

  const continueEditingRequirement = useCallback((requirement: Requirement) => {
    setDismissedPromptRequirementId(requirement.id);
  }, []);

  useEffect(() => {
    if (!observedRequirementId || !selectedProjectId) {
      return;
    }

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
        setRequirementStreamEvents((current) => [...current, parsed]);

        const transient =
          parsed.event === "coordinator_started" ||
          parsed.event === "coordinator_progress" ||
          parsed.event === "coordinator_time_warning" ||
          parsed.event === "pi_event";
        if (!transient) {
          void Promise.all([
            loadProjectCanvas(selectedProjectId),
            loadRequirementConversation(parsed.requirement_id),
          ]).catch((reason) => setRequirementError(readError(reason)));
        }
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

    return () => source.close();
  }, [
    loadRequirementConversation,
    loadProjectCanvas,
    observedRequirementId,
    selectedProjectId,
  ]);

  return {
    requirementInput,
    setRequirementInput,
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
    continueEditingRequirement,
  };
}
