import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectCanvasData, Requirement } from "../types/api";
import {
  getProjectCanvas,
  planRequirementExecution,
  recoverTaskGroup as apiRecoverTaskGroup,
  cancelRequirementAnalysis as apiCancelRequirementAnalysis,
  deleteRequirement as apiDeleteRequirement,
} from "../api/client";
import { readError } from "../utils/format";

function hasSameRequirementRevision(
  current: Requirement | null,
  next: Requirement | null,
) {
  return (
    current?.id === next?.id &&
    current?.status === next?.status &&
    current?.updated_at === next?.updated_at
  );
}

function hasSameRequirementRevisions(
  current: Requirement[],
  next: Requirement[],
) {
  return (
    current.length === next.length &&
    current.every((requirement, index) =>
      hasSameRequirementRevision(requirement, next[index]),
    )
  );
}

function hasSameProjectCanvasRevision(
  current: ProjectCanvasData | null,
  next: ProjectCanvasData | null,
) {
  return (
    current?.project.id === next?.project.id &&
    current?.project.updated_at === next?.project.updated_at &&
    hasSameRequirementRevision(
      current?.active_requirement ?? null,
      next?.active_requirement ?? null,
    ) &&
    hasSameRequirementRevisions(
      current?.queued_requirements ?? [],
      next?.queued_requirements ?? [],
    ) &&
    hasSameRequirementRevisions(
      current?.completed_requirements ?? [],
      next?.completed_requirements ?? [],
    )
  );
}

export function useProjectCanvas(
  selectedProjectId: string | null,
  setError: (error: string | null) => void,
) {
  const [projectCanvas, setProjectCanvasState] =
    useState<ProjectCanvasData | null>(null);
  const setProjectCanvas = useCallback(
    (next: ProjectCanvasData | null) =>
      setProjectCanvasState((current) =>
        hasSameProjectCanvasRevision(current, next) ? current : next,
      ),
    [],
  );
  const [selectedDagRequirementId, setSelectedDagRequirementId] = useState<
    string | null
  >(null);
  const [collapsedTaskGroups, setCollapsedTaskGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [requirementActionBusyId, setRequirementActionBusyId] = useState<
    string | null
  >(null);
  const [recoveringTaskGroupIds, setRecoveringTaskGroupIds] = useState<
    Set<string>
  >(() => new Set());
  const [requirementActionError, setRequirementActionError] = useState<
    string | null
  >(null);
  const projectCanvasRequest = useRef<{
    projectId: string;
    promise: Promise<ProjectCanvasData>;
  } | null>(null);

  const loadProjectCanvas = useCallback((projectId: string) => {
    if (projectCanvasRequest.current?.projectId === projectId) {
      return projectCanvasRequest.current.promise;
    }

    const promise = getProjectCanvas(projectId)
      .then((data) => {
        setProjectCanvas(data);
        return data;
      })
      .finally(() => {
        if (projectCanvasRequest.current?.promise === promise) {
          projectCanvasRequest.current = null;
        }
      });
    projectCanvasRequest.current = { projectId, promise };
    return promise;
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setProjectCanvas(null);
      setSelectedDagRequirementId(null);
      setRequirementActionBusyId(null);
      setRecoveringTaskGroupIds(new Set());
      setRequirementActionError(null);
      return;
    }

    let cancelled = false;
    setProjectCanvas(null);

    loadProjectCanvas(selectedProjectId)
      .then(() => {
        if (!cancelled) {
          setError(null);
        }
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(readError(reason));
      });

    return () => {
      cancelled = true;
    };
  }, [loadProjectCanvas, selectedProjectId, setError]);

  const toggleTaskGroupCollapsed = useCallback(
    (requirementId: string, taskId: string) => {
      const key = `${requirementId}:${taskId}`;
      setCollapsedTaskGroups((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    },
    [],
  );

  const allProjectRequirements = useMemo(() => {
    const requirements = [
      ...(projectCanvas?.active_requirement
        ? [projectCanvas.active_requirement]
        : []),
      ...(projectCanvas?.queued_requirements ?? []),
      ...(projectCanvas?.completed_requirements ?? []),
    ];
    return requirements.filter(
      (requirement, index, list) =>
        list.findIndex((item) => item.id === requirement.id) === index,
    );
  }, [projectCanvas]);

  const activeRequirementId = projectCanvas?.active_requirement?.id ?? null;
  const selectedDagRequirement =
    allProjectRequirements.find(
      (requirement) => requirement.id === selectedDagRequirementId,
    ) ?? null;
  const observedRequirementId = selectedDagRequirementId ?? activeRequirementId;
  const shouldPollProjectCanvas = allProjectRequirements.some(
    (requirement) =>
      requirement.status === "planning" || requirement.status === "running",
  );

  useEffect(() => {
    if (!selectedProjectId || !shouldPollProjectCanvas) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadProjectCanvas(selectedProjectId).catch((reason) =>
        setError(readError(reason)),
      );
    }, 2500);
    return () => window.clearInterval(timer);
  }, [loadProjectCanvas, selectedProjectId, setError, shouldPollProjectCanvas]);

  useEffect(() => {
    if (
      selectedDagRequirementId &&
      projectCanvas &&
      !allProjectRequirements.some(
        (requirement) => requirement.id === selectedDagRequirementId,
      )
    ) {
      setSelectedDagRequirementId(null);
    }
  }, [allProjectRequirements, projectCanvas, selectedDagRequirementId]);

  const selectDagRequirement = useCallback((requirement: Requirement) => {
    setRequirementActionError(null);
    setSelectedDagRequirementId(requirement.id);
  }, []);

  const closeDag = useCallback(() => {
    setRequirementActionError(null);
    setSelectedDagRequirementId(null);
  }, []);

  const planRequirement = useCallback(
    async (requirement: Requirement) => {
      setSelectedDagRequirementId(requirement.id);
      setRequirementActionBusyId(requirement.id);
      try {
        const data = await planRequirementExecution(requirement.id);
        setProjectCanvas(data);
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setRequirementActionBusyId(null);
      }
    },
    [setError],
  );

  const recoverTaskGroup = useCallback(
    async (requirementId: string, taskId: string) => {
      const key = `${requirementId}:${taskId}`;
      setRecoveringTaskGroupIds((current) => new Set(current).add(key));
      setRequirementActionError(null);
      try {
        const data = await apiRecoverTaskGroup(requirementId, taskId);
        setProjectCanvas(data);
        setSelectedDagRequirementId(requirementId);
      } catch (reason) {
        setRequirementActionError(readError(reason));
      } finally {
        setRecoveringTaskGroupIds((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [],
  );

  const cancelRequirementAnalysis = useCallback(
    async (requirementId: string) => {
      try {
        const data = await apiCancelRequirementAnalysis(requirementId);
        setProjectCanvas(data);
      } catch (reason) {
        setRequirementActionError(readError(reason));
      }
    },
    [],
  );

  const abandonRequirement = useCallback(async (requirementId: string) => {
    try {
      const data = await apiDeleteRequirement(requirementId);
      setProjectCanvas(data);
      setSelectedDagRequirementId(null);
    } catch (reason) {
      setRequirementActionError(readError(reason));
    }
  }, []);

  return {
    projectCanvas,
    setProjectCanvas,
    loadProjectCanvas,
    selectedDagRequirementId,
    setSelectedDagRequirementId,
    selectedDagRequirement,
    observedRequirementId,
    activeRequirementId,
    allProjectRequirements,
    collapsedTaskGroups,
    toggleTaskGroupCollapsed,
    requirementActionBusyId,
    recoveringTaskGroupIds,
    requirementActionError,
    selectDagRequirement,
    closeDag,
    planRequirement,
    recoverTaskGroup,
    cancelRequirementAnalysis,
    abandonRequirement,
  };
}
