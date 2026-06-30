import type { RequirementExecutionTask } from "../types/api";

export type TaskPosition = { x: number; y: number };
export type TaskSize = { width: number; height: number };

export const DAG_NODE_POSITION = { x: 1140, y: 80 };
export const DAG_NODE_SIZE = { width: 360, height: 260 };
export const TASK_COLUMN_GAP = 130;

export const TASK_BASE_POSITION = {
  x: DAG_NODE_POSITION.x + DAG_NODE_SIZE.width + TASK_COLUMN_GAP,
  y: 4,
};
const TASK_ROW_GAP = 72;
const IMPLEMENTATION_WIDTH = 590;
const EXTERNAL_TASK_SIZE = { width: 380, height: 220 };
const GROUP_MIN_HEIGHT = 300;
const GROUP_HEADER_HEIGHT = 96;
const GROUP_PADDING_X = 20;
const GROUP_PADDING_BOTTOM = 20;
const GROUP_COLUMN_GAP = 36;
const GROUP_ROW_GAP = 14;

type LayoutNode = {
  id: string;
  dependsOn: string[];
  size: TaskSize;
};

export function getTaskLayout(
  tasks: RequirementExecutionTask[],
): Map<string, TaskPosition> {
  return layoutLayers(
    tasks.filter(isExternalDagTask).map((task) => ({
      id: task.id,
      dependsOn: task.depends_on,
      size: getTaskNodeSize(task, tasks),
    })),
    TASK_BASE_POSITION.x,
    TASK_BASE_POSITION.y,
    TASK_COLUMN_GAP,
    TASK_ROW_GAP,
  );
}

export function getTaskGroupLayout(
  task: RequirementExecutionTask,
  reviews: RequirementExecutionTask[],
) {
  const summary = reviews.find((review) => review.kind === "review_summary");
  const nodes = [task, ...reviews].map((item) => ({
    id: item.id,
    dependsOn:
      item.id === task.id
        ? []
        : item.kind === "review_summary"
          ? [task.id]
          : [summary?.id ?? task.id],
    size: getTaskGroupChildSize(item),
  }));
  const positions = layoutLayers(
    nodes,
    GROUP_PADDING_X,
    GROUP_HEADER_HEIGHT,
    GROUP_COLUMN_GAP,
    GROUP_ROW_GAP,
  );
  const bounds = nodes.reduce(
    (size, node) => {
      const position = positions.get(node.id) ?? {
        x: GROUP_PADDING_X,
        y: GROUP_HEADER_HEIGHT,
      };
      return {
        width: Math.max(size.width, position.x + node.size.width),
        height: Math.max(size.height, position.y + node.size.height),
      };
    },
    { width: 0, height: 0 },
  );

  return {
    positions,
    width: Math.max(IMPLEMENTATION_WIDTH, bounds.width + GROUP_PADDING_X),
    height: Math.max(GROUP_MIN_HEIGHT, bounds.height + GROUP_PADDING_BOTTOM),
  };
}

export function isExternalDagTask(task: RequirementExecutionTask | undefined) {
  return (
    task?.kind === "implementation" ||
    task?.kind === "branch_merge" ||
    task?.kind === "merge_review"
  );
}

export function getTaskNodeSize(
  task: RequirementExecutionTask,
  tasks: RequirementExecutionTask[] = [],
): TaskSize {
  if (task.kind !== "implementation") return EXTERNAL_TASK_SIZE;
  const reviews = tasks.filter((review) => review.review_for === task.id);
  const group = getTaskGroupLayout(task, reviews);
  return { width: group.width, height: group.height };
}

export function externalNodeId(task: RequirementExecutionTask) {
  return task.kind === "implementation"
    ? `requirement-task-group-${task.id}`
    : `requirement-task-${task.id}`;
}

export function getTaskGroupChildSize(
  task: RequirementExecutionTask,
): TaskSize {
  if (task.kind === "review_sub_agent" || task.kind === "review") {
    return { width: 140, height: 52 };
  }
  return { width: 142, height: 142 };
}

function layoutLayers(
  nodes: LayoutNode[],
  baseX: number,
  baseY: number,
  columnGap: number,
  rowGap: number,
) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const layerCache = new Map<string, number>();

  function resolveLayer(nodeId: string, visiting = new Set<string>()): number {
    const cached = layerCache.get(nodeId);
    if (cached !== undefined) return cached;
    const node = nodeMap.get(nodeId);
    if (!node || visiting.has(nodeId)) return 0;

    visiting.add(nodeId);
    const dependencies = node.dependsOn.filter((dependency) =>
      nodeMap.has(dependency),
    );
    const layer =
      dependencies.length === 0
        ? 0
        : Math.max(
            ...dependencies.map((dependency) =>
              resolveLayer(dependency, new Set(visiting)),
            ),
          ) + 1;
    layerCache.set(nodeId, layer);
    return layer;
  }

  const layerNodes = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    const layer = resolveLayer(node.id);
    const list = layerNodes.get(layer) ?? [];
    list.push(node);
    layerNodes.set(layer, list);
  }

  const layers = [...layerNodes.keys()].sort((left, right) => left - right);
  const positions = new Map<string, TaskPosition>();
  const maxColumnHeight = Math.max(
    0,
    ...layers.map((layer) => columnHeight(layerNodes.get(layer) ?? [], rowGap)),
  );
  let currentX = baseX;

  for (const layer of layers) {
    const previousOrder = new Map<string, number>(
      [...positions.entries()].map(([id, position]) => [id, position.y]),
    );
    const orderedNodes = [...(layerNodes.get(layer) ?? [])].sort(
      (left, right) =>
        dependencyWeight(left, previousOrder) -
          dependencyWeight(right, previousOrder) ||
        (nodeOrder.get(left.id) ?? 0) - (nodeOrder.get(right.id) ?? 0),
    );
    const height = columnHeight(orderedNodes, rowGap);
    let currentY = baseY + (maxColumnHeight - height) / 2;
    for (const node of orderedNodes) {
      positions.set(node.id, { x: currentX, y: currentY });
      currentY += node.size.height + rowGap;
    }
    currentX +=
      Math.max(0, ...orderedNodes.map((node) => node.size.width)) + columnGap;
  }

  return positions;
}

function columnHeight(nodes: LayoutNode[], rowGap: number) {
  if (nodes.length === 0) return 0;
  return (
    nodes.reduce((height, node) => height + node.size.height, 0) +
    rowGap * (nodes.length - 1)
  );
}

function dependencyWeight(
  node: LayoutNode,
  previousOrder: Map<string, number>,
) {
  const dependencyRows = node.dependsOn
    .map((dependency) => previousOrder.get(dependency))
    .filter((row): row is number => row !== undefined);
  if (dependencyRows.length === 0) return Number.POSITIVE_INFINITY;
  return (
    dependencyRows.reduce((total, row) => total + row, 0) /
    dependencyRows.length
  );
}
