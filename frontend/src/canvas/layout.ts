import type { WorkflowSnapshot } from "../types/api";

export const MAIN_NODE_Y = 20;

export const REQUIREMENT_CHAT_NODE_SIZE = { width: 960, height: 760 };
export const REQUIREMENT_LIST_NODE_SIZE = { width: 360, height: 760 };
export const WORKFLOW_RUN_NODE_SIZE = { width: 560, height: 760 };

const MAIN_NODE_HORIZONTAL_GAP = 60;

const WORK_ITEM_WIDTH = 340;
const WORK_ITEM_HEIGHT = 220;
const RANK_GAP = 120;
const ROW_GAP = 32;

export function mainNodePositions(): Record<
  "requirement-chat" | "requirement-list" | "workflow-run",
  { x: number; y: number }
> {
  const chatX = 0;
  const listX =
    chatX + REQUIREMENT_CHAT_NODE_SIZE.width + MAIN_NODE_HORIZONTAL_GAP;
  const runX =
    listX + REQUIREMENT_LIST_NODE_SIZE.width + MAIN_NODE_HORIZONTAL_GAP;

  return {
    "requirement-chat": { x: chatX, y: MAIN_NODE_Y },
    "requirement-list": { x: listX, y: MAIN_NODE_Y },
    "workflow-run": { x: runX, y: MAIN_NODE_Y },
  };
}

export function workflowRunNodePosition() {
  return mainNodePositions()["workflow-run"];
}

export function workflowItemPositions(workflow: WorkflowSnapshot) {
  const runPosition = workflowRunNodePosition();
  const byId = new Map(workflow.work_items.map((item) => [item.id, item]));
  const dependencies = new Map<string, string[]>();
  for (const dependency of workflow.dependencies) {
    const current = dependencies.get(dependency.work_item_id) ?? [];
    current.push(dependency.depends_on_id);
    dependencies.set(dependency.work_item_id, current);
  }

  const ranks = new Map<string, number>();
  const unresolved = new Set(workflow.work_items.map((item) => item.id));
  while (unresolved.size > 0) {
    let progressed = false;
    for (const id of [...unresolved]) {
      const parents = dependencies.get(id) ?? [];
      if (parents.every((parent) => ranks.has(parent) || !byId.has(parent))) {
        ranks.set(
          id,
          parents.length === 0
            ? 0
            : Math.max(...parents.map((parent) => ranks.get(parent) ?? 0)) + 1,
        );
        unresolved.delete(id);
        progressed = true;
      }
    }
    if (!progressed) {
      for (const id of unresolved) ranks.set(id, 0);
      break;
    }
  }

  const rankItems = new Map<number, typeof workflow.work_items>();
  for (const item of workflow.work_items) {
    const rank = ranks.get(item.id) ?? 0;
    const current = rankItems.get(rank) ?? [];
    current.push(item);
    rankItems.set(rank, current);
  }

  const rowOrder = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  const centerY = runPosition.y + WORKFLOW_RUN_NODE_SIZE.height / 2;

  for (const rank of [...rankItems.keys()].sort(
    (left, right) => left - right,
  )) {
    const items = rankItems.get(rank) ?? [];
    items.sort((left, right) => {
      const barycenter = (id: string) => {
        const parents = dependencies.get(id) ?? [];
        if (parents.length === 0) return byId.get(id)?.position ?? 0;
        return (
          parents.reduce(
            (total, parent) => total + (rowOrder.get(parent) ?? 0),
            0,
          ) / parents.length
        );
      };
      return (
        barycenter(left.id) - barycenter(right.id) ||
        left.position - right.position
      );
    });

    const totalHeight =
      items.length * WORK_ITEM_HEIGHT + Math.max(0, items.length - 1) * ROW_GAP;
    const startY = centerY - totalHeight / 2;

    items.forEach((item, index) => {
      rowOrder.set(item.id, index);
      positions.set(item.id, {
        x:
          runPosition.x +
          WORKFLOW_RUN_NODE_SIZE.width +
          RANK_GAP +
          rank * (WORK_ITEM_WIDTH + RANK_GAP),
        y: startY + index * (WORK_ITEM_HEIGHT + ROW_GAP),
      });
    });
  }
  return positions;
}
