import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectCanvasData, Requirement } from "../types/api";
import {
  getProjectCanvas,
  startRequirementWorkflow,
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
    ) &&
    hasSameWorkflowRevisions(
      current?.workflow_runs ?? [],
      next?.workflow_runs ?? [],
    )
  );
}

function hasSameWorkflowRevisions(
  current: NonNullable<ProjectCanvasData["workflow_runs"]>,
  next: NonNullable<ProjectCanvasData["workflow_runs"]>,
) {
  return (
    current.length === next.length &&
    current.every((workflow, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        workflow.run.id === candidate.run.id &&
        workflow.run.version === candidate.run.version &&
        workflow.run.status === candidate.run.status &&
        workflow.last_event_sequence === candidate.last_event_sequence
      );
    })
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
  const [selectedWorkflowRequirementId, setSelectedWorkflowRequirementId] =
    useState<string | null>(null);
  const [requirementActionBusyId, setRequirementActionBusyId] = useState<
    string | null
  >(null);
  const [requirementActionError, setRequirementActionError] = useState<
    string | null
  >(null);
  const projectCanvasRequest = useRef<{
    projectId: string;
    workflowRequirementId: string | null;
    promise: Promise<ProjectCanvasData>;
  } | null>(null);

  const loadProjectCanvas = useCallback(
    (projectId: string, workflowRequirementId: string | null = null) => {
      if (
        projectCanvasRequest.current?.projectId === projectId &&
        projectCanvasRequest.current.workflowRequirementId ===
          workflowRequirementId
      ) {
        return projectCanvasRequest.current.promise;
      }

      const promise = getProjectCanvas(projectId, workflowRequirementId)
        .then((data) => {
          if (projectCanvasRequest.current?.promise === promise) {
            setProjectCanvas(data);
          }
          return data;
        })
        .finally(() => {
          if (projectCanvasRequest.current?.promise === promise) {
            projectCanvasRequest.current = null;
          }
        });
      projectCanvasRequest.current = {
        projectId,
        workflowRequirementId,
        promise,
      };
      return promise;
    },
    [],
  );

  useEffect(() => {
    if (!selectedProjectId) {
      setProjectCanvas(null);
      setSelectedWorkflowRequirementId(null);
      setRequirementActionBusyId(null);
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
  const selectedWorkflowRequirement =
    allProjectRequirements.find(
      (requirement) => requirement.id === selectedWorkflowRequirementId,
    ) ?? null;
  const observedRequirementId =
    selectedWorkflowRequirementId ?? activeRequirementId;
  const planningBlocked = projectCanvas?.queued_requirements.some(
    (requirement) => requirement.status === "failed",
  );
  const shouldPollProjectCanvas =
    !planningBlocked &&
    allProjectRequirements.some((requirement) =>
      ["queued", "planning", "plan_ready", "running"].includes(
        requirement.status,
      ),
    );

  useEffect(() => {
    if (!selectedProjectId || !shouldPollProjectCanvas) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadProjectCanvas(
        selectedProjectId,
        selectedWorkflowRequirementId,
      ).catch((reason) => setError(readError(reason)));
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [
    loadProjectCanvas,
    selectedWorkflowRequirementId,
    selectedProjectId,
    setError,
    shouldPollProjectCanvas,
  ]);

  useEffect(() => {
    if (
      selectedWorkflowRequirementId &&
      projectCanvas &&
      !allProjectRequirements.some(
        (requirement) => requirement.id === selectedWorkflowRequirementId,
      )
    ) {
      setSelectedWorkflowRequirementId(null);
    }
  }, [allProjectRequirements, projectCanvas, selectedWorkflowRequirementId]);

  const selectWorkflowRequirement = useCallback(
    (requirement: Requirement) => {
      setRequirementActionError(null);
      setSelectedWorkflowRequirementId(requirement.id);
      if (selectedProjectId) {
        void loadProjectCanvas(selectedProjectId, requirement.id).catch(
          (reason) => setRequirementActionError(readError(reason)),
        );
      }
    },
    [loadProjectCanvas, selectedProjectId],
  );

  const closeWorkflow = useCallback(() => {
    setRequirementActionError(null);
    setSelectedWorkflowRequirementId(null);
    if (selectedProjectId) {
      void loadProjectCanvas(selectedProjectId).catch((reason) =>
        setRequirementActionError(readError(reason)),
      );
    }
  }, [loadProjectCanvas, selectedProjectId]);

  const planRequirement = useCallback(
    async (requirement: Requirement) => {
      setSelectedWorkflowRequirementId(requirement.id);
      setRequirementActionBusyId(requirement.id);
      try {
        const data = await startRequirementWorkflow(requirement.id);
        setProjectCanvas(data);
        if (selectedProjectId) {
          await loadProjectCanvas(selectedProjectId, requirement.id);
        }
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setRequirementActionBusyId(null);
      }
    },
    [loadProjectCanvas, selectedProjectId, setError],
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
      setSelectedWorkflowRequirementId(null);
    } catch (reason) {
      setRequirementActionError(readError(reason));
    }
  }, []);

  return {
    projectCanvas,
    setProjectCanvas,
    loadProjectCanvas,
    selectedWorkflowRequirementId,
    setSelectedWorkflowRequirementId,
    selectedWorkflowRequirement,
    observedRequirementId,
    activeRequirementId,
    allProjectRequirements,
    requirementActionBusyId,
    requirementActionError,
    selectWorkflowRequirement,
    closeWorkflow,
    planRequirement,
    cancelRequirementAnalysis,
    abandonRequirement,
  };
}
