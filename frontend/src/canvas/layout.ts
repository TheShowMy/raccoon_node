import type { RequirementExecutionTask } from "../types/api";

export type TaskPosition = { x: number; y: number };

const BASE_X = 700;
const BASE_Y = 4;
const COLUMN_GAP = 720;
const ROW_GAP = 72;

export function getTaskLayout(
  tasks: RequirementExecutionTask[],
): Map<string, TaskPosition> {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));
  const externalTasks = tasks.filter(isExternalDagTask);
  const layerCache = new Map<string, number>();

  function resolveLayer(taskId: string, visiting = new Set<string>()): number {
    const cached = layerCache.get(taskId);
    if (cached !== undefined) return cached;
    const task = taskMap.get(taskId);
    if (
      !task ||
      !isExternalDagTask(task) ||
      visiting.has(taskId) ||
      task.depends_on.length === 0
    ) {
      layerCache.set(taskId, 0);
      return 0;
    }

    visiting.add(taskId);
    const externalDependencies = task.depends_on.filter((dependency) =>
      isExternalDagTask(taskMap.get(dependency)),
    );
    const layer =
      externalDependencies.length === 0
        ? 0
        : Math.max(
            ...externalDependencies.map((dependency) =>
              resolveLayer(dependency, new Set(visiting)),
            ),
          ) + 1;
    layerCache.set(taskId, layer);
    return layer;
  }

  const layerTasks = new Map<number, RequirementExecutionTask[]>();
  for (const task of externalTasks) {
    const layer = resolveLayer(task.id);
    const list = layerTasks.get(layer) ?? [];
    list.push(task);
    layerTasks.set(layer, list);
  }

  const layers = [...layerTasks.keys()].sort((left, right) => left - right);
  const positions = new Map<string, TaskPosition>();
  const maxColumnHeight = Math.max(
    0,
    ...layers.map((layer) => columnHeight(layerTasks.get(layer) ?? [])),
  );

  for (const layer of layers) {
    const previousOrder = new Map<string, number>(
      [...positions.entries()].map(([id, position]) => [id, position.y]),
    );
    const orderedTasks = [...(layerTasks.get(layer) ?? [])].sort(
      (left, right) =>
        dependencyWeight(left, previousOrder) -
          dependencyWeight(right, previousOrder) ||
        (taskOrder.get(left.id) ?? 0) - (taskOrder.get(right.id) ?? 0),
    );
    const height = columnHeight(orderedTasks);
    let currentY = BASE_Y + (maxColumnHeight - height) / 2;
    for (const task of orderedTasks) {
      positions.set(task.id, {
        x: BASE_X + layer * COLUMN_GAP,
        y: currentY,
      });
      currentY += getTaskNodeHeight(task) + ROW_GAP;
    }
  }

  return positions;
}

export function isExternalDagTask(task: RequirementExecutionTask | undefined) {
  return (
    task?.kind === "implementation" ||
    task?.kind === "branch_merge" ||
    task?.kind === "merge_review"
  );
}

export function getTaskNodeHeight(task: RequirementExecutionTask) {
  return task.kind === "implementation" ? 300 : 220;
}

export function externalNodeId(task: RequirementExecutionTask) {
  return task.kind === "implementation"
    ? `requirement-task-group-${task.id}`
    : `requirement-task-${task.id}`;
}

function columnHeight(tasks: RequirementExecutionTask[]) {
  if (tasks.length === 0) return 0;
  return (
    tasks.reduce((height, task) => height + getTaskNodeHeight(task), 0) +
    ROW_GAP * (tasks.length - 1)
  );
}

function dependencyWeight(
  task: RequirementExecutionTask,
  previousOrder: Map<string, number>,
) {
  const dependencyRows = task.depends_on
    .map((dependency) => previousOrder.get(dependency))
    .filter((row): row is number => row !== undefined);
  if (dependencyRows.length === 0) return Number.POSITIVE_INFINITY;
  return (
    dependencyRows.reduce((total, row) => total + row, 0) /
    dependencyRows.length
  );
}
