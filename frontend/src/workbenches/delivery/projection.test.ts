import { describe, expect, it } from "vitest";
import { buildDemoPlan } from "../../api/mock/demoContent";
import type { PendingAction, Requirement, Run } from "../../api/types";
import { deliveryNodeId, projectDelivery } from "./projection";

/**
 * 子画布投影（FE-DELIVERY-003/006）：选中需求只展开一跳关系；
 * 依赖边区分串行/合并/阻断（FE-RUN-004）；危险操作确认链成节点（FE-CANVAS-019）。
 */

const requirement: Requirement = {
  id: "req-1",
  title: "演示需求",
  state: "queued",
  source_branch_id: "b-main",
  source_node_ids: ["n-1"],
  latest_revision: 1,
  confirmed_revision: 1,
  queue_position: 1,
  latest_run_id: "run-1",
  created_at: "2026-01-01T00:00:00.000Z",
};

const run: Run = {
  id: "run-1",
  requirement_id: "req-1",
  requirement_revision: 1,
  phase: "executing",
  resume_phase: null,
  outcome: null,
  blocked_reason: null,
  cancel_reason: null,
  current_activity: null,
  publication_path: "github_pull_request",
  publication_frozen_reason: "",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function baseInput() {
  return {
    requirements: { "req-1": requirement },
    clarifications: {},
    revisions: { "req-1": [] },
    runs: { "run-1": run },
    plans: {},
    validations: {},
    reviews: {},
    publications: {},
    actions: {},
    selectedRequirementId: "req-1",
  };
}

describe("projectDelivery", () => {
  it("未选中需求：只有列表锚点", () => {
    const projection = projectDelivery({
      ...baseInput(),
      selectedRequirementId: null,
    });
    expect(projection.nodes.map((node) => node.id)).toEqual(["req-list"]);
    expect(projection.edges).toEqual([]);
  });

  it("无 Run 的待确认需求：来源 → 澄清 → 规格 → 确认 链", () => {
    const projection = projectDelivery({
      ...baseInput(),
      requirements: {
        "req-1": { ...requirement, latest_run_id: null, state: "spec_ready" },
      },
      clarifications: {
        "clr-1": {
          id: "clr-1",
          requirement_id: "req-1",
          question: "问题",
          options: ["A"],
          answer: null,
          state: "pending",
          asked_at: "2026-01-01T00:00:00.000Z",
          answered_at: null,
        },
      },
      revisions: {
        "req-1": [
          {
            requirement_id: "req-1",
            revision: 1,
            spec: {
              goal: "",
              user_value: "",
              in_scope: [],
              out_of_scope: [],
              scenarios: [],
              constraints: [],
              non_goals: [],
              risks: [],
              assumptions: [],
              evidence: [],
            },
            semantic_hash: "abc",
            created_at: "2026-01-01T00:00:00.000Z",
            source_graph_id: "g-main",
            source_branch_id: "b-main",
            source_node_ids: [],
            confirmation: null,
          },
        ],
      },
      runs: {},
    });
    const ids = projection.nodes.map((node) => node.id);
    expect(ids).toContain("req-source:req-1");
    expect(ids).toContain("req-clar:clr-1");
    expect(ids).toContain("req-spec:req-1");
    expect(ids).toContain("req-confirm:req-1");
    expect(ids).not.toContain("run:run-1");
    const edgeIds = projection.edges.map((edge) => edge.id);
    expect(edgeIds).toContain("e-req-source:req-1-req-clar:clr-1");
    expect(edgeIds).toContain("e-req-spec:req-1-req-confirm:req-1");
  });

  it("一跳展开：Run/计划/工作项/Diff/验证/审核/发布/诊断 + 依赖边语义", () => {
    const plan = buildDemoPlan("plan-1", "run-1", 1);
    const projection = projectDelivery({
      ...baseInput(),
      plans: { "run-1": plan },
      publications: {
        "run-1": {
          run_id: "run-1",
          path: "github_pull_request",
          frozen_reason: "",
          state: "not_started",
          branch: "main",
          commit: null,
          pr_url: null,
          ci_fix_attempts: 0,
          remote_merged: false,
          local_synced: false,
          blocked_reason: null,
        },
      },
    });
    const ids = projection.nodes.map((node) => node.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "req-list",
        "run:run-1",
        "plan:run-1",
        "diff:run-1",
        "val:run-1",
        "rev:run-1",
        "pub:run-1",
        "diag:run-1",
      ]),
    );
    for (const item of plan.items) {
      expect(ids).toContain(`wi:${item.id}`);
    }
    // 并行批 → 合并任务：merge 边（plan → 合并任务的 chain 边不计入）
    const mergeTask = plan.items.find((item) => item.kind === "merge_task")!;
    const mergeEdges = projection.edges.filter(
      (edge) =>
        edge.target === `wi:${mergeTask.id}` && edge.className === "de-merge",
    );
    expect(mergeEdges).toHaveLength(2);
    expect(mergeEdges.every((edge) => edge.className === "de-merge")).toBe(
      true,
    );
    const serialEdge = projection.edges.find(
      (edge) =>
        edge.source === `wi:${mergeTask.id}` && edge.className === "de-serial",
    );
    expect(serialEdge).toBeDefined();
    // 合并任务 → Diff
    expect(
      projection.edges.some(
        (edge) => edge.target === "diff:run-1" && edge.className === "de-merge",
      ),
    ).toBe(true);
  });

  it("阻断工作项的依赖边为 de-blocked（不只靠颜色）", () => {
    const plan = buildDemoPlan("plan-1", "run-1", 1);
    plan.items = plan.items.map((item) =>
      item.kind === "merge_task" ? { ...item, status: "blocked" } : item,
    );
    const projection = projectDelivery({
      ...baseInput(),
      plans: { "run-1": plan },
    });
    const mergeTask = plan.items.find((item) => item.kind === "merge_task")!;
    const blockedEdges = projection.edges.filter(
      (edge) =>
        (edge.target === `wi:${mergeTask.id}` ||
          edge.source === `wi:${mergeTask.id}`) &&
        edge.className === "de-blocked",
    );
    expect(blockedEdges.length).toBeGreaterThan(0);
  });

  it("危险操作：awaiting → 确认节点（红色链）；已确认 → 结果节点", () => {
    const action = (partial: Partial<PendingAction>): PendingAction => ({
      id: "act-1",
      kind: "abandon_run",
      run_id: "run-1",
      requirement_id: "req-1",
      title: "放弃 Run",
      impact: "",
      irreversible: true,
      state: "awaiting",
      result: null,
      created_at: "2026-01-01T00:00:00.000Z",
      ...partial,
    });
    const awaiting = projectDelivery({
      ...baseInput(),
      actions: { "act-1": action({}) },
    });
    expect(
      awaiting.nodes.some((node) => node.type === "action_confirmation"),
    ).toBe(true);
    expect(
      awaiting.edges.some(
        (edge) =>
          edge.target === deliveryNodeId.actionConfirmation("act-1") &&
          edge.className === "de-blocked",
      ),
    ).toBe(true);
    const confirmed = projectDelivery({
      ...baseInput(),
      actions: {
        "act-1": action({
          state: "confirmed",
          result: { ok: true, message: "已放弃" },
        }),
      },
    });
    expect(confirmed.nodes.some((node) => node.type === "action_result")).toBe(
      true,
    );
  });
});
