import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { planEdgeKind } from "../../api/workplan";
import { validateWorkPlan } from "../../api/workplan";
import type {
  PendingAction,
  Publication,
  Requirement,
  RequirementRevision,
  Run,
  RunReview,
  RunValidation,
  WorkItem,
  WorkPlan,
} from "../../api/types";

/**
 * 确定需求交付投影：列表只包含已经确认或曾经执行的需求；选择后只展开
 * Run、分层 WorkPlan、质量与发布，不复制对话中的澄清、规格和确认节点。
 */

export type DeliveryNodeKind =
  | "requirement_list"
  | "requirement_summary"
  | "run"
  | "work_plan"
  | "plan_invalid"
  | "stage_band"
  | "work_item"
  | "diff"
  | "validation"
  | "review"
  | "publication"
  | "diagnostics"
  | "action_confirmation"
  | "action_result";

export type DeliveryFlowNode = Node<Record<string, unknown>>;

export const deliveryNodeId = {
  list: () => "req-list",
  requirement: (requirementId: string) => `req:${requirementId}`,
  run: (runId: string) => `run:${runId}`,
  plan: (runId: string) => `plan:${runId}`,
  planInvalid: (runId: string) => `plan-invalid:${runId}`,
  stage: (runId: string, level: number) => `stage:${runId}:${level}`,
  workItem: (itemId: string) => `wi:${itemId}`,
  diff: (runId: string) => `diff:${runId}`,
  validation: (runId: string) => `val:${runId}`,
  review: (runId: string) => `rev:${runId}`,
  publication: (runId: string) => `pub:${runId}`,
  diagnostics: (runId: string) => `diag:${runId}`,
  actionConfirmation: (actionId: string) => `action:${actionId}`,
  actionResult: (actionId: string) => `action-result:${actionId}`,
};

export const TASK_NODE_WIDTH = 360;
export const TASK_NODE_HEIGHT = 208;
export const MERGE_NODE_WIDTH = 320;
export const MERGE_NODE_HEIGHT = 160;
export const TASK_LEVEL_GAP = 112;
export const TASK_LANE_GAP = 48;

/**
 * Run 节点「定位」目标：执行阶段跟随活动工作项；
 * 验证/审核/发布阶段跳到对应质量节点；其余阶段不提供定位。
 */
export function runLocateTarget(
  run: Run,
  activeWorkItemId: string | null,
): { nodeId: string; label: string } | null {
  if (activeWorkItemId) {
    return {
      nodeId: deliveryNodeId.workItem(activeWorkItemId),
      label: "定位当前任务",
    };
  }
  if (run.phase === "validating") {
    return { nodeId: deliveryNodeId.validation(run.id), label: "定位验证" };
  }
  if (run.phase === "reviewing") {
    return { nodeId: deliveryNodeId.review(run.id), label: "定位审核" };
  }
  if (run.phase === "publishing") {
    return { nodeId: deliveryNodeId.publication(run.id), label: "定位发布" };
  }
  return null;
}

const LIST_X = 0;
const SUMMARY_X = 380;
const RUN_X = 820;
const PLAN_X = 1300;
const TASK_START_X = 1752;
const FLOW_CENTER_Y = 104;
const QUALITY_NODE_WIDTH = 420;
const QUALITY_GAP = 112;

export type TaskLayout = {
  positions: Record<string, { x: number; y: number; level: number }>;
  levels: WorkItem[][];
  roots: WorkItem[];
  terminals: WorkItem[];
  issues: string[];
  maxBottom: number;
  endX: number;
};

function itemSize(item: WorkItem) {
  return item.kind === "merge_task"
    ? { width: MERGE_NODE_WIDTH, height: MERGE_NODE_HEIGHT }
    : { width: TASK_NODE_WIDTH, height: TASK_NODE_HEIGHT };
}

/** 纯函数分层布局：最长依赖路径定列，父节点重心与 position 定同层顺序。 */
export function layoutWorkItems(items: WorkItem[]): TaskLayout {
  const byId = new Map(items.map((item) => [item.id, item]));
  const issues: string[] = [];
  const indegree = new Map<string, number>();
  const children = new Map<string, WorkItem[]>();

  for (const item of items) {
    const validDeps = item.depends_on.filter((dependency) => {
      if (byId.has(dependency)) return true;
      issues.push(`${item.title}：依赖不存在的工作项 ${dependency}`);
      return false;
    });
    indegree.set(item.id, validDeps.length);
    for (const dependency of validDeps) {
      const next = children.get(dependency) ?? [];
      next.push(item);
      children.set(dependency, next);
    }
  }

  const roots = items
    .filter((item) => (indegree.get(item.id) ?? 0) === 0)
    .sort((a, b) => a.position - b.position);
  const queue = [...roots];
  const levelById = new Map<string, number>(roots.map((item) => [item.id, 0]));
  const visited: WorkItem[] = [];

  while (queue.length > 0) {
    const item = queue.shift()!;
    visited.push(item);
    for (const child of children.get(item.id) ?? []) {
      levelById.set(
        child.id,
        Math.max(
          levelById.get(child.id) ?? 0,
          (levelById.get(item.id) ?? 0) + 1,
        ),
      );
      const next = (indegree.get(child.id) ?? 0) - 1;
      indegree.set(child.id, next);
      if (next === 0) queue.push(child);
    }
    queue.sort((a, b) => a.position - b.position);
  }

  if (visited.length !== items.length) issues.push("计划依赖存在环");
  if (issues.length > 0) {
    return {
      positions: {},
      levels: [],
      roots,
      terminals: [],
      issues,
      maxBottom: FLOW_CENTER_Y,
      endX: TASK_START_X,
    };
  }

  const maxLevel = Math.max(-1, ...levelById.values());
  const levels: WorkItem[][] = [];
  const orderById = new Map<string, number>();
  for (let level = 0; level <= maxLevel; level += 1) {
    const members = items.filter((item) => levelById.get(item.id) === level);
    members.sort((a, b) => {
      const parentCenter = (item: WorkItem) => {
        if (item.depends_on.length === 0) return item.position;
        return (
          item.depends_on.reduce(
            (sum, id) => sum + (orderById.get(id) ?? byId.get(id)!.position),
            0,
          ) / item.depends_on.length
        );
      };
      return parentCenter(a) - parentCenter(b) || a.position - b.position;
    });
    members.forEach((item, index) => orderById.set(item.id, index));
    levels.push(members);
  }

  const positions: TaskLayout["positions"] = {};
  let maxBottom = FLOW_CENTER_Y;
  for (const [level, members] of levels.entries()) {
    const totalHeight =
      members.reduce((sum, item) => sum + itemSize(item).height, 0) +
      Math.max(0, members.length - 1) * TASK_LANE_GAP;
    let y = FLOW_CENTER_Y - totalHeight / 2;
    for (const item of members) {
      const size = itemSize(item);
      positions[item.id] = {
        x: TASK_START_X + level * (TASK_NODE_WIDTH + TASK_LEVEL_GAP),
        y,
        level,
      };
      y += size.height + TASK_LANE_GAP;
      maxBottom = Math.max(maxBottom, y - TASK_LANE_GAP);
    }
  }

  const terminals = items
    .filter((item) => (children.get(item.id) ?? []).length === 0)
    .sort((a, b) => a.position - b.position);
  return {
    positions,
    levels,
    roots,
    terminals,
    issues,
    maxBottom,
    endX:
      maxLevel < 0
        ? TASK_START_X
        : TASK_START_X +
          maxLevel * (TASK_NODE_WIDTH + TASK_LEVEL_GAP) +
          TASK_NODE_WIDTH,
  };
}

export type DeliveryProjectionInput = {
  requirements: Record<string, Requirement>;
  revisions: Record<string, RequirementRevision[]>;
  runs: Record<string, Run>;
  plans: Record<string, WorkPlan>;
  validations: Record<string, RunValidation>;
  reviews: Record<string, RunReview>;
  publications: Record<string, Publication>;
  actions: Record<string, PendingAction>;
  selectedRequirementId: string | null;
  diagnosticsRunId: string | null;
};

export type DeliveryProjection = {
  nodes: DeliveryFlowNode[];
  edges: Edge[];
};

function flowNode(
  id: string,
  kind: DeliveryNodeKind,
  x: number,
  y: number,
  data: Record<string, unknown>,
  size?: { width: number; height: number },
  zIndex = 1,
): DeliveryFlowNode {
  return {
    id,
    type: kind,
    position: { x, y },
    data,
    style: size ? { width: size.width, height: size.height } : undefined,
    zIndex,
    draggable: false,
    selectable: false,
    deletable: false,
  };
}

function chainEdge(
  source: string,
  target: string,
  kind: "chain" | "serial" | "merge" | "blocked" | "future",
  sourceHandle = "out-r",
  targetHandle = "in-l",
  routeOffset = 24,
): Edge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle,
    targetHandle,
    type: "smoothstep",
    pathOptions: { borderRadius: 0, offset: routeOffset },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    className: `de-${kind}`,
    selectable: false,
    focusable: false,
  } as Edge;
}

function separatedPort(side: "in-l" | "out-r", index: number, count: number) {
  if (count <= 1) return side;
  if (count === 2) return `${side}-${index === 0 ? "top" : "bottom"}`;
  return index === 0 ? `${side}-top` : index === 2 ? `${side}-bottom` : side;
}

function isConfirmedForDelivery(requirement: Requirement) {
  return (
    requirement.confirmed_revision !== null ||
    requirement.latest_run_id !== null
  );
}

function latestConfirmedRevision(
  requirement: Requirement,
  revisions: RequirementRevision[],
) {
  const revision =
    requirement.confirmed_revision ?? requirement.latest_revision;
  return (
    revisions.find((entry) => entry.revision === revision) ??
    revisions.at(-1) ??
    null
  );
}

function actionSourceId(action: PendingAction, run: Run) {
  if (action.kind === "force_deliver_unreviewed")
    return deliveryNodeId.review(run.id);
  if (action.kind === "publication_retry")
    return deliveryNodeId.publication(run.id);
  return deliveryNodeId.run(run.id);
}

export function projectDelivery(
  input: DeliveryProjectionInput,
): DeliveryProjection {
  const nodes: DeliveryFlowNode[] = [];
  const edges: Edge[] = [];
  nodes.push(
    flowNode(deliveryNodeId.list(), "requirement_list", LIST_X, 0, {}),
  );

  const requirement = input.selectedRequirementId
    ? input.requirements[input.selectedRequirementId]
    : undefined;
  if (!requirement || !isConfirmedForDelivery(requirement))
    return { nodes, edges };

  const revision = latestConfirmedRevision(
    requirement,
    input.revisions[requirement.id] ?? [],
  );
  const requirementId = deliveryNodeId.requirement(requirement.id);
  nodes.push(
    flowNode(requirementId, "requirement_summary", SUMMARY_X, 0, {
      requirement,
      revision,
    }),
  );
  edges.push(chainEdge(deliveryNodeId.list(), requirementId, "chain"));

  const run = requirement.latest_run_id
    ? input.runs[requirement.latest_run_id]
    : undefined;
  if (!run) return { nodes, edges };

  const plan = input.plans[run.id];
  const activeWorkItemId =
    plan?.items.find((item) => item.status === "running")?.id ??
    plan?.items.find((item) => item.status === "blocked")?.id ??
    null;
  const runId = deliveryNodeId.run(run.id);
  nodes.push(
    flowNode(runId, "run", RUN_X, 0, {
      run,
      requirement,
      validation: input.validations[run.id] ?? null,
      review: input.reviews[run.id] ?? null,
      activeWorkItemId,
    }),
  );
  edges.push(chainEdge(requirementId, runId, "chain"));

  let layout: TaskLayout = {
    positions: {},
    levels: [],
    roots: [],
    terminals: [],
    issues: [],
    maxBottom: FLOW_CENTER_Y,
    endX: TASK_START_X,
  };
  let planId: string | null = null;
  if (plan) {
    planId = deliveryNodeId.plan(run.id);
    layout = layoutWorkItems(plan.items);
    const deterministicValidation = validateWorkPlan(
      plan.items,
      revision?.spec.scenarios ?? [],
    );
    const validationIssues = [
      ...new Set([
        ...plan.validation.issues,
        ...deterministicValidation.issues,
        ...layout.issues,
      ]),
    ];
    const effectivePlan: WorkPlan =
      !plan.validation.ok || validationIssues.length > 0
        ? { ...plan, validation: { ok: false, issues: validationIssues } }
        : plan;
    nodes.push(
      flowNode(planId, "work_plan", PLAN_X, 0, { plan: effectivePlan, run }),
    );
    edges.push(chainEdge(runId, planId, "chain"));
    if (!effectivePlan.validation.ok) {
      nodes.push(
        flowNode(
          deliveryNodeId.planInvalid(run.id),
          "plan_invalid",
          TASK_START_X,
          0,
          { plan: effectivePlan, issues: validationIssues },
        ),
      );
      edges.push(
        chainEdge(planId, deliveryNodeId.planInvalid(run.id), "blocked"),
      );
    } else {
      for (const [level, members] of layout.levels.entries()) {
        if (members.length === 0) continue;
        const tops = members.map((item) => layout.positions[item.id].y);
        const bottoms = members.map(
          (item) => layout.positions[item.id].y + itemSize(item).height,
        );
        const x = layout.positions[members[0].id].x - 16;
        const y = Math.min(...tops) - 44;
        const parallel = members.length > 1;
        nodes.push(
          flowNode(
            deliveryNodeId.stage(run.id, level),
            "stage_band",
            x,
            y,
            {
              label: members.every((item) => item.kind === "merge_task")
                ? `第 ${level + 1} 层 · 汇合`
                : `第 ${level + 1} 层 · ${parallel ? "并行" : "串行"}`,
            },
            {
              width: TASK_NODE_WIDTH + 32,
              height: Math.max(...bottoms) - y + 16,
            },
            0,
          ),
        );
      }

      for (const item of plan.items) {
        const position = layout.positions[item.id];
        const size = itemSize(item);
        nodes.push(
          flowNode(
            deliveryNodeId.workItem(item.id),
            "work_item",
            position.x,
            position.y,
            { item, runPhase: run.phase, runId: run.id, planItems: plan.items },
            size,
          ),
        );
      }
      const rootsByLane = [...layout.roots].sort(
        (a, b) => layout.positions[a.id].y - layout.positions[b.id].y,
      );
      for (const [index, root] of rootsByLane.entries()) {
        edges.push(
          chainEdge(
            planId,
            deliveryNodeId.workItem(root.id),
            "chain",
            separatedPort("out-r", index, rootsByLane.length),
          ),
        );
      }
      for (const item of plan.items) {
        const dependenciesByLane = item.depends_on
          .map((dependency) =>
            plan.items.find((entry) => entry.id === dependency),
          )
          .filter((entry): entry is WorkItem => Boolean(entry))
          .sort((a, b) => layout.positions[a.id].y - layout.positions[b.id].y);
        for (const [dependencyIndex, source] of dependenciesByLane.entries()) {
          const childrenByLane = plan.items
            .filter((entry) => entry.depends_on.includes(source.id))
            .sort(
              (a, b) => layout.positions[a.id].y - layout.positions[b.id].y,
            );
          const childIndex = childrenByLane.findIndex(
            (entry) => entry.id === item.id,
          );
          edges.push(
            chainEdge(
              deliveryNodeId.workItem(source.id),
              deliveryNodeId.workItem(item.id),
              planEdgeKind(source, item),
              separatedPort("out-r", childIndex, childrenByLane.length),
              separatedPort("in-l", dependencyIndex, dependenciesByLane.length),
              28 + Math.max(childIndex, dependencyIndex) * 14,
            ),
          );
        }
      }
    }
  }

  const qualityX = Math.max(layout.endX + TASK_LEVEL_GAP, TASK_START_X + 432);
  const diffId = deliveryNodeId.diff(run.id);
  nodes.push(
    flowNode(diffId, "diff", qualityX, 0, {
      run,
      terminalItems: layout.terminals,
    }),
  );
  const planIsDrawable =
    plan &&
    plan.validation.ok &&
    layout.issues.length === 0 &&
    validateWorkPlan(plan.items, revision?.spec.scenarios ?? []).ok;
  if (planIsDrawable) {
    if (layout.terminals.length === 0 && planId) {
      edges.push(chainEdge(planId, diffId, "future"));
    } else {
      for (const terminal of layout.terminals) {
        edges.push(
          chainEdge(
            deliveryNodeId.workItem(terminal.id),
            diffId,
            terminal.status === "blocked" ? "blocked" : "chain",
          ),
        );
      }
    }
  }

  const validationId = deliveryNodeId.validation(run.id);
  const reviewId = deliveryNodeId.review(run.id);
  const publicationId = deliveryNodeId.publication(run.id);
  nodes.push(
    flowNode(
      validationId,
      "validation",
      qualityX + QUALITY_NODE_WIDTH + QUALITY_GAP,
      0,
      {
        run,
        validation: input.validations[run.id] ?? null,
      },
    ),
    flowNode(
      reviewId,
      "review",
      qualityX + 2 * (QUALITY_NODE_WIDTH + QUALITY_GAP),
      0,
      {
        run,
        review: input.reviews[run.id] ?? null,
      },
    ),
    flowNode(
      publicationId,
      "publication",
      qualityX + 3 * (QUALITY_NODE_WIDTH + QUALITY_GAP),
      0,
      { run, publication: input.publications[run.id] ?? null },
    ),
  );
  edges.push(
    chainEdge(diffId, validationId, "future"),
    chainEdge(validationId, reviewId, "future"),
    chainEdge(reviewId, publicationId, "future"),
  );

  const auxiliaryY = Math.max(layout.maxBottom + 180, 500);
  if (input.diagnosticsRunId === run.id) {
    nodes.push(
      flowNode(
        deliveryNodeId.diagnostics(run.id),
        "diagnostics",
        RUN_X,
        auxiliaryY,
        {
          run,
          requirement,
        },
      ),
    );
  }

  const positions = new Map(nodes.map((node) => [node.id, node.position]));
  const runActions = Object.values(input.actions)
    .filter((action) => action.run_id === run.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  runActions.forEach((action, index) => {
    const sourceId = actionSourceId(action, run);
    const sourcePosition = positions.get(sourceId) ?? { x: RUN_X, y: 0 };
    const id =
      action.state === "awaiting"
        ? deliveryNodeId.actionConfirmation(action.id)
        : deliveryNodeId.actionResult(action.id);
    nodes.push(
      flowNode(
        id,
        action.state === "awaiting" ? "action_confirmation" : "action_result",
        sourcePosition.x + index * 32,
        auxiliaryY,
        { action },
      ),
    );
    edges.push(
      chainEdge(
        sourceId,
        id,
        action.state === "awaiting" ? "blocked" : "chain",
        "out-b",
        "in-t",
      ),
    );
  });

  return { nodes, edges };
}
