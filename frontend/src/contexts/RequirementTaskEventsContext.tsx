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
