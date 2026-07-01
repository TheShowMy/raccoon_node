import { createContext, useContext, type ReactNode } from "react";
import type { StreamEvent } from "../types/api";

const RequirementTaskEventsContext = createContext<{
  requirementId: string | null;
  events: StreamEvent[];
}>({ requirementId: null, events: [] });

export function RequirementTaskEventsProvider({
  requirementId,
  events,
  children,
}: {
  requirementId: string | null;
  events: StreamEvent[];
  children: ReactNode;
}) {
  return (
    <RequirementTaskEventsContext.Provider value={{ requirementId, events }}>
      {children}
    </RequirementTaskEventsContext.Provider>
  );
}

export function useRequirementTaskEvents(taskId: string) {
  const { requirementId, events } = useContext(RequirementTaskEventsContext);
  return requirementId
    ? events.filter(
        (event) =>
          event.requirement_id === requirementId && event.task_id === taskId,
      )
    : [];
}

export function useRequirementPlanningThinking() {
  const { requirementId, events } = useContext(RequirementTaskEventsContext);
  if (!requirementId) return "";

  const planningEvents = events.filter(
    (event) => event.requirement_id === requirementId && event.task_id == null,
  );
  let planningStart = -1;
  for (let index = planningEvents.length - 1; index >= 0; index -= 1) {
    if (planningEvents[index].event === "execution_planning_started") {
      planningStart = index;
      break;
    }
  }
  return planningEvents
    .slice(planningStart + 1)
    .flatMap((event) => {
      if (event.event !== "pi_event" || event.pi_type !== "message_update") {
        return [];
      }
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;
      const assistantEvent =
        payload?.assistantMessageEvent &&
        typeof payload.assistantMessageEvent === "object"
          ? (payload.assistantMessageEvent as Record<string, unknown>)
          : null;
      return assistantEvent?.type === "thinking_delta" &&
        typeof assistantEvent.delta === "string"
        ? [assistantEvent.delta]
        : [];
    })
    .join("");
}
