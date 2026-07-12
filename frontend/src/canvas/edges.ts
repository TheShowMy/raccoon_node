import { MarkerType, type Edge } from "@xyflow/react";
import type { Requirement } from "../types/api";
import {
  externalNodeId,
  getTaskGroupDependencies,
  isExternalDagTask,
} from "./layout";

const ENTRY_EDGE_COLOR = "var(--color-accent)";
const DEPENDENCY_EDGE_COLOR = "var(--color-border-emphasized)";
const REVIEW_EDGE_COLOR = "var(--color-border-blue)";

export function buildRequirementDagEdges(
  requirement: Requirement,
  collapsedTaskGroups: Set<string>,
): Edge[] {
  const flowEdges: Edge[] = [];
  flowEdges.push({
    id: "requirements-to-requirement-dag",
    source: "requirements",
    sourceHandle: "requirement-list-right",
    target: "requirement-dag",
    targetHandle: "requirement-dag-left",
    type: "smoothstep",
    animated: true,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: ENTRY_EDGE_COLOR,
    },
    style: {
      stroke: ENTRY_EDGE_COLOR,
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
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: ENTRY_EDGE_COLOR,
        },
        style: {
          stroke: ENTRY_EDGE_COLOR,
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
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: DEPENDENCY_EDGE_COLOR,
        },
        style: {
          stroke: DEPENDENCY_EDGE_COLOR,
          strokeWidth: 2,
        },
      });
    }
  }

  for (const task of tasks.filter((task) => task.kind === "implementation")) {
    if (collapsedTaskGroups.has(`${requirement.id}:${task.id}`)) continue;
    const reviews = tasks.filter((review) => review.review_for === task.id);
    const dependencies = getTaskGroupDependencies(task, reviews);
    const children = [task, ...reviews];
    const childById = new Map(children.map((child) => [child.id, child]));

    for (const target of reviews) {
      for (const dependency of dependencies.get(target.id) ?? []) {
        if (!childById.has(dependency)) continue;
        const color =
          target.kind === "review_sub_agent" || target.kind === "review"
            ? REVIEW_EDGE_COLOR
            : DEPENDENCY_EDGE_COLOR;
        flowEdges.push({
          id: `requirement-task-${dependency}-to-${target.id}`,
          source: `requirement-task-${dependency}`,
          sourceHandle: "requirement-task-right",
          target: `requirement-task-${target.id}`,
          targetHandle: "requirement-task-left",
          type: "straight",
          animated: target.status === "running",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
          },
          style: {
            stroke: color,
            strokeWidth: 1.4,
          },
        });
      }
    }
  }

  return flowEdges;
}
