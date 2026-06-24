import { MarkerType, type Edge } from "@xyflow/react";
import type { Requirement } from "../types/api";
import { externalNodeId, isExternalDagTask } from "./layout";

export function buildRequirementDagEdges(
  requirement: Requirement,
  collapsedTaskGroups: Set<string>,
): Edge[] {
  const flowEdges: Edge[] = [];
  const sourceList =
    requirement.status === "completed"
      ? "completed-requirements"
      : "queued-requirements";
  flowEdges.push({
    id: `${sourceList}-to-requirement-dag`,
    source: sourceList,
    sourceHandle: "requirement-list-right",
    target: "requirement-dag",
    targetHandle: "requirement-dag-left",
    type: "smoothstep",
    animated: true,
    style: {
      stroke: "rgba(249, 115, 22, 0.68)",
      strokeWidth: 2,
    },
  });

  const tasks = requirement.execution_plan?.tasks ?? [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const externalTasks = tasks.filter(isExternalDagTask);

  for (const task of externalTasks) {
    const externalDependencies = task.depends_on.filter((dependency) =>
      isExternalDagTask(taskById.get(dependency)),
    );

    if (externalDependencies.length === 0) {
      flowEdges.push({
        id: `requirement-dag-to-task-${task.id}`,
        source: "requirement-dag",
        sourceHandle: "requirement-dag-entry",
        target: externalNodeId(task),
        targetHandle: "requirement-task-left",
        type: "smoothstep",
        animated: task.status === "running",
        style: {
          stroke: "rgba(249, 115, 22, 0.64)",
          strokeWidth: 2,
        },
      });
    }

    for (const dependency of externalDependencies) {
      const dependencyTask = taskById.get(dependency);
      if (!dependencyTask) continue;
      flowEdges.push({
        id: `requirement-task-${dependency}-to-${task.id}`,
        source: externalNodeId(dependencyTask),
        sourceHandle: "requirement-task-right",
        target: externalNodeId(task),
        targetHandle: "requirement-task-left",
        type: "smoothstep",
        animated: task.status === "running",
        style: {
          stroke: "rgba(20, 184, 166, 0.62)",
          strokeWidth: 2,
        },
      });
    }
  }

  for (const task of tasks.filter((task) => task.kind === "implementation")) {
    if (collapsedTaskGroups.has(`${requirement.id}:${task.id}`)) continue;
    const reviews = tasks.filter((review) => review.review_for === task.id);
    const summary = reviews.find((review) => review.kind === "review_summary");
    const reviewNodes = reviews.filter(
      (review) =>
        review.kind === "review_sub_agent" || review.kind === "review",
    );
    if (!summary) continue;
    flowEdges.push({
      id: `requirement-task-${task.id}-to-${summary.id}`,
      source: `requirement-task-${task.id}`,
      sourceHandle: "requirement-task-right",
      target: `requirement-task-${summary.id}`,
      targetHandle: "requirement-task-left",
      type: "straight",
      animated: summary.status === "running",
      markerStart: {
        type: MarkerType.ArrowClosed,
        color: "rgba(20, 184, 166, 0.62)",
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "rgba(20, 184, 166, 0.62)",
      },
      style: {
        stroke: "rgba(20, 184, 166, 0.62)",
        strokeWidth: 1.4,
      },
    });
    for (const review of reviewNodes) {
      flowEdges.push({
        id: `requirement-task-${summary.id}-to-${review.id}`,
        source: `requirement-task-${summary.id}`,
        sourceHandle: "requirement-task-right",
        target: `requirement-task-${review.id}`,
        targetHandle: "requirement-task-left",
        type: "straight",
        animated: review.status === "running" || summary.status === "running",
        markerStart: {
          type: MarkerType.ArrowClosed,
          color: "rgba(99, 102, 241, 0.58)",
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "rgba(99, 102, 241, 0.58)",
        },
        style: {
          stroke: "rgba(99, 102, 241, 0.58)",
          strokeWidth: 1.3,
        },
      });
    }
  }

  return flowEdges;
}
