import { MarkerType, type Edge } from "@xyflow/react";
import type { Requirement, WorkflowSnapshot } from "../types/api";

const ENTRY_EDGE_COLOR = "var(--color-accent)";
const DEPENDENCY_EDGE_COLOR = "var(--color-border-emphasized)";

export function buildWorkflowRunEdges(
  _requirement: Requirement,
  workflow: WorkflowSnapshot | null,
): Edge[] {
  const edges: Edge[] = [
    {
      id: "requirements-to-workflow-run",
      source: "requirements",
      sourceHandle: "requirement-list-right",
      target: "workflow-run",
      targetHandle: "workflow-run-left",
      type: "smoothstep",
      animated: true,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: ENTRY_EDGE_COLOR,
      },
      style: { stroke: ENTRY_EDGE_COLOR, strokeWidth: 2 },
    },
  ];
  if (!workflow) return edges;

  const dependencies = new Map<string, string[]>();
  for (const dependency of workflow.dependencies) {
    const values = dependencies.get(dependency.work_item_id) ?? [];
    values.push(dependency.depends_on_id);
    dependencies.set(dependency.work_item_id, values);
  }
  for (const item of workflow.work_items) {
    const sources = dependencies.get(item.id) ?? [];
    if (sources.length === 0) {
      edges.push({
        id: `workflow-entry-${item.id}`,
        source: "workflow-run",
        sourceHandle: "workflow-run-entry",
        target: `workflow-item-${item.id}`,
        targetHandle: "workflow-item-left",
        type: "smoothstep",
        animated: item.status === "running",
        markerEnd: { type: MarkerType.ArrowClosed, color: ENTRY_EDGE_COLOR },
        style: { stroke: ENTRY_EDGE_COLOR, strokeWidth: 2 },
      });
      continue;
    }
    for (const source of sources) {
      edges.push({
        id: `workflow-${source}-to-${item.id}`,
        source: `workflow-item-${source}`,
        sourceHandle: "workflow-item-right",
        target: `workflow-item-${item.id}`,
        targetHandle: "workflow-item-left",
        type: "smoothstep",
        animated: ["leased", "running"].includes(item.status),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: DEPENDENCY_EDGE_COLOR,
        },
        style: { stroke: DEPENDENCY_EDGE_COLOR, strokeWidth: 2 },
      });
    }
  }
  return edges;
}
