import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectCanvasData, Requirement } from "../types/api";
import {
  getProjectCanvas,
  planRequirementExecution,
  startRequirementExecution,
  retryFailedNode,
  retryFromNode,
  rerunReview,
} from "../api/client";
import { readError } from "../utils/format";

export function useProjectCanvas(
  selectedProjectId: string | null,
  currentCanvas: "start" | "project",
  setError: (error: string | null) => void,
  setCurrentCanvas: (canvas: "start" | "project") => void,
  setSelectedProjectId: (id: string | null) => void,
) {
  const [projectCanvas, setProjectCanvas] = useState<ProjectCanvasData | null>(
    null,
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

  const loadProjectCanvas = useCallback(async (projectId: string) => {
    const data = await getProjectCanvas(projectId);
    setProjectCanvas(data);
    return data;
  }, []);

  useEffect(() => {
    if (currentCanvas !== "project" || !selectedProjectId) {
      setProjectCanvas(null);
      setSelectedDagRequirementId(null);
      setRequirementActionBusyId(null);
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
        window.history.replaceState({}, "", "/");
        setCurrentCanvas("start");
        setSelectedProjectId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    currentCanvas,
    loadProjectCanvas,
    selectedProjectId,
    setCurrentCanvas,
    setError,
    setSelectedProjectId,
  ]);

  useEffect(() => {
    if (currentCanvas !== "project") {
      setSelectedDagRequirementId(null);
      setCollapsedTaskGroups(new Set());
      setRequirementActionBusyId(null);
    }
  }, [currentCanvas]);

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
    setSelectedDagRequirementId(requirement.id);
  }, []);

  const closeDag = useCallback(() => {
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

  const startExecution = useCallback(
    async (requirement: Requirement) => {
      setSelectedDagRequirementId(requirement.id);
      setRequirementActionBusyId(requirement.id);
      try {
        const data = await startRequirementExecution(requirement.id);
        setProjectCanvas(data);
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setRequirementActionBusyId(null);
      }
    },
    [setError],
  );

  const runTaskRecoveryAction = useCallback(
    async (
      requirementId: string,
      taskId: string,
      action: (
        requirementId: string,
        taskId: string,
      ) => Promise<ProjectCanvasData>,
    ) => {
      setRequirementActionBusyId(requirementId);
      try {
        const data = await action(requirementId, taskId);
        setProjectCanvas(data);
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setRequirementActionBusyId(null);
      }
    },
    [setError],
  );

  const retryFailedNode = useCallback(
    (requirementId: string, taskId: string) =>
      runTaskRecoveryAction(requirementId, taskId, retryFailedNode),
    [runTaskRecoveryAction],
  );

  const retryFromNode = useCallback(
    (requirementId: string, taskId: string) =>
      runTaskRecoveryAction(requirementId, taskId, retryFromNode),
    [runTaskRecoveryAction],
  );

  const rerunReview = useCallback(
    (requirementId: string, taskId: string) =>
      runTaskRecoveryAction(requirementId, taskId, rerunReview),
    [runTaskRecoveryAction],
  );

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
    selectDagRequirement,
    closeDag,
    planRequirement,
    startExecution,
    retryFailedNode,
    retryFromNode,
    rerunReview,
  };
}
