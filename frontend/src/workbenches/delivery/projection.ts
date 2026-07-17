import type { Edge, Node } from "@xyflow/react";
import { planEdgeKind } from "../../api/workplan";
import type {
  ClarificationRound,
  PendingAction,
  Publication,
  Requirement,
  RequirementRevision,
  Run,
  RunReview,
  RunValidation,
  WorkPlan,
} from "../../api/types";

/**
 * 需求子画布投影（FE-DELIVERY-001/003/006，纯函数）：
 * 需求列表是空间锚点；选中需求只展开一跳关系——来源对话、澄清、规格、
 * 确认、Run、WorkPlan、工作项、Diff、验证、审核、发布、诊断与操作确认链。
 */

export type DeliveryNodeKind =
  | "requirement_list"
  | "source_ref"
  | "clarification"
  | "spec"
  | "confirmation"
  | "run"
  | "work_plan"
  | "work_item"
  | "diff"
  | "validation"
  | "review"
  | "publication"
  | "diagnostics"
  | "action_confirmation"
  | "action_result";

export type DeliveryFlowNode = Node<Record<string, unknown>>;

/** 子画布节点 id（深链与 GrayDango 定位共用） */
export const deliveryNodeId = {
  list: () => "req-list",
  source: (requirementId: string) => `req-source:${requirementId}`,
  clarification: (roundId: string) => `req-clar:${roundId}`,
  spec: (requirementId: string) => `req-spec:${requirementId}`,
  confirmation: (requirementId: string) => `req-confirm:${requirementId}`,
  run: (runId: string) => `run:${runId}`,
  plan: (runId: string) => `plan:${runId}`,
  workItem: (itemId: string) => `wi:${itemId}`,
  diff: (runId: string) => `diff:${runId}`,
  validation: (runId: string) => `val:${runId}`,
  review: (runId: string) => `rev:${runId}`,
  publication: (runId: string) => `pub:${runId}`,
  diagnostics: (runId: string) => `diag:${runId}`,
  actionConfirmation: (actionId: string) => `action:${actionId}`,
  actionResult: (actionId: string) => `action-result:${actionId}`,
};

/* 固定列布局（逻辑坐标）：第一行关系链，第二行质量与发布，操作节点居中 */
const COL = {
  list: 0,
  source: 360,
  clarification: 700,
  spec: 1100,
  confirmation: 1580,
  run: 1980,
  plan: 2400,
  items: 2800,
  diff: 3220,
} as const;

const ROW1_Y = 0;
const ACTION_Y = 440;
const ROW2_Y = 660;
const ITEM_HEIGHT = 210;
const ITEM_GAP = 24;

export type DeliveryProjectionInput = {
  requirements: Record<string, Requirement>;
  clarifications: Record<string, ClarificationRound>;
  revisions: Record<string, RequirementRevision[]>;
  runs: Record<string, Run>;
  plans: Record<string, WorkPlan>;
  validations: Record<string, RunValidation>;
  reviews: Record<string, RunReview>;
  publications: Record<string, Publication>;
  actions: Record<string, PendingAction>;
  selectedRequirementId: string | null;
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
): DeliveryFlowNode {
  return {
    id,
    type: kind,
    position: { x, y },
    data,
    draggable: false,
    selectable: false,
    deletable: false,
  };
}

function chainEdge(
  source: string,
  target: string,
  kind: "chain" | "serial" | "merge" | "blocked",
  sourceHandle = "out-r",
  targetHandle = "in-l",
): Edge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle,
    targetHandle,
    className: `de-${kind}`,
    selectable: false,
    focusable: false,
  };
}

export function projectDelivery(
  input: DeliveryProjectionInput,
): DeliveryProjection {
  const nodes: DeliveryFlowNode[] = [];
  const edges: Edge[] = [];

  nodes.push(
    flowNode(deliveryNodeId.list(), "requirement_list", COL.list, ROW1_Y, {}),
  );

  const requirement = input.selectedRequirementId
    ? input.requirements[input.selectedRequirementId]
    : undefined;
  if (!requirement) return { nodes, edges };

  /* 来源对话（一跳关系的起点） */
  let chainTip: { id: string; handle: string } | null = null;
  if (requirement.source_branch_id) {
    const id = deliveryNodeId.source(requirement.id);
    nodes.push(flowNode(id, "source_ref", COL.source, ROW1_Y, { requirement }));
    chainTip = { id, handle: "out-r" };
  }

  /* 澄清（最新一轮； answered 后保留为事实节点） */
  const rounds = Object.values(input.clarifications)
    .filter((round) => round.requirement_id === requirement.id)
    .sort((a, b) => a.asked_at.localeCompare(b.asked_at));
  const latestRound = rounds.at(-1);
  if (latestRound) {
    const id = deliveryNodeId.clarification(latestRound.id);
    nodes.push(
      flowNode(id, "clarification", COL.clarification, ROW1_Y, {
        round: latestRound,
      }),
    );
    if (chainTip) edges.push(chainEdge(chainTip.id, id, "chain"));
    chainTip = { id, handle: "out-r" };
  }

  /* 规格（revision 链在节点内部切换） */
  const revisions = input.revisions[requirement.id] ?? [];
  if (revisions.length > 0) {
    const id = deliveryNodeId.spec(requirement.id);
    nodes.push(
      flowNode(id, "spec", COL.spec, ROW1_Y, { requirement, revisions }),
    );
    if (chainTip) edges.push(chainEdge(chainTip.id, id, "chain"));
    chainTip = { id, handle: "out-r" };

    /* 确认：指向特定 revision（PRD-SPEC-006） */
    const confirmId = deliveryNodeId.confirmation(requirement.id);
    nodes.push(
      flowNode(confirmId, "confirmation", COL.confirmation, ROW1_Y, {
        requirement,
        revisions,
      }),
    );
    edges.push(chainEdge(chainTip.id, confirmId, "chain"));
    chainTip = { id: confirmId, handle: "out-r" };
  }

  /* Run 与一跳下游 */
  const run = requirement.latest_run_id
    ? input.runs[requirement.latest_run_id]
    : undefined;
  if (!run) return { nodes, edges };

  const runId = deliveryNodeId.run(run.id);
  nodes.push(
    flowNode(runId, "run", COL.run, ROW1_Y, {
      run,
      requirement,
      validation: input.validations[run.id] ?? null,
      review: input.reviews[run.id] ?? null,
    }),
  );
  if (chainTip) edges.push(chainEdge(chainTip.id, runId, "chain"));

  /* WorkPlan + 工作项/合并任务（DAG 边区分串行/合并/阻断，FE-RUN-004） */
  const plan = input.plans[run.id];
  if (plan) {
    const planId = deliveryNodeId.plan(run.id);
    nodes.push(flowNode(planId, "work_plan", COL.plan, ROW1_Y, { plan, run }));
    edges.push(chainEdge(runId, planId, "chain"));
    const sorted = [...plan.items].sort((a, b) => a.position - b.position);
    sorted.forEach((item, index) => {
      const itemId = deliveryNodeId.workItem(item.id);
      nodes.push(
        flowNode(
          itemId,
          "work_item",
          COL.items,
          ROW1_Y + index * (ITEM_HEIGHT + ITEM_GAP),
          {
            item,
            runPhase: run.phase,
            runId: run.id,
          },
        ),
      );
      edges.push(chainEdge(planId, itemId, "chain"));
      for (const depId of item.depends_on) {
        const source = plan.items.find((entry) => entry.id === depId);
        if (!source) continue;
        edges.push(
          chainEdge(
            deliveryNodeId.workItem(depId),
            itemId,
            planEdgeKind(source, item),
          ),
        );
      }
    });
    const mergeTask = plan.items.find((item) => item.kind === "merge_task");
    if (mergeTask) {
      const diffId = deliveryNodeId.diff(run.id);
      nodes.push(
        flowNode(diffId, "diff", COL.diff, ROW1_Y, { run, mergeTask }),
      );
      edges.push(
        chainEdge(deliveryNodeId.workItem(mergeTask.id), diffId, "merge"),
      );
    }
  }

  /* 第二行：验证 → 审核 → 发布 + 诊断（Run 的一跳下游） */
  const validationId = deliveryNodeId.validation(run.id);
  nodes.push(
    flowNode(validationId, "validation", COL.run, ROW2_Y, {
      run,
      validation: input.validations[run.id] ?? null,
    }),
  );
  edges.push(chainEdge(runId, validationId, "chain", "out-b", "in-t"));

  const reviewId = deliveryNodeId.review(run.id);
  nodes.push(
    flowNode(reviewId, "review", COL.plan, ROW2_Y, {
      run,
      review: input.reviews[run.id] ?? null,
    }),
  );
  edges.push(chainEdge(validationId, reviewId, "chain"));

  const publication = input.publications[run.id];
  if (publication) {
    const publicationId = deliveryNodeId.publication(run.id);
    nodes.push(
      flowNode(publicationId, "publication", COL.items, ROW2_Y, {
        run,
        publication,
      }),
    );
    edges.push(chainEdge(reviewId, publicationId, "chain"));
  }

  const diagnosticsId = deliveryNodeId.diagnostics(run.id);
  nodes.push(
    flowNode(diagnosticsId, "diagnostics", COL.diff, ROW2_Y, {
      run,
      requirement,
    }),
  );
  edges.push(chainEdge(runId, diagnosticsId, "chain", "out-b", "in-t"));

  /* 危险操作确认链（FE-CANVAS-019）：来源节点 → 确认节点 → 结果节点 */
  const runActions = Object.values(input.actions)
    .filter((action) => action.run_id === run.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  runActions.forEach((action, index) => {
    const x = COL.run + index * 400;
    if (action.state === "awaiting") {
      const id = deliveryNodeId.actionConfirmation(action.id);
      nodes.push(flowNode(id, "action_confirmation", x, ACTION_Y, { action }));
      edges.push(chainEdge(runId, id, "blocked", "out-b", "in-t"));
    } else if (action.result) {
      const id = deliveryNodeId.actionResult(action.id);
      nodes.push(flowNode(id, "action_result", x, ACTION_Y, { action }));
      edges.push(chainEdge(runId, id, "chain", "out-b", "in-t"));
    }
  });

  return { nodes, edges };
}
