import { describe, expect, it } from "vitest";
import { buildDemoPlan } from "../../api/mock/demoContent";
import type {
  PendingAction,
  Requirement,
  Run,
  WorkItem,
} from "../../api/types";
import {
  TASK_LANE_GAP,
  TASK_LEVEL_GAP,
  TASK_NODE_WIDTH,
  deliveryNodeId,
  layoutWorkItems,
  projectDelivery,
  runLocateTarget,
} from "./projection";

const requirement: Requirement = {
  id: "req-1",
  title: "演示需求",
  state: "queued",
  source_session_id: "s-main",
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
  task_budget_usd: 25,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function baseInput() {
  return {
    requirements: { "req-1": requirement },
    revisions: { "req-1": [] },
    runs: { "run-1": run },
    plans: {},
    validations: {},
    reviews: {},
    publications: {},
    actions: {},
    selectedRequirementId: "req-1",
    diagnosticsRunId: null,
  };
}

describe("确定需求交付投影", () => {
  it("未选择或尚未确认时只显示列表锚点", () => {
    expect(
      projectDelivery({
        ...baseInput(),
        selectedRequirementId: null,
      }).nodes.map((node) => node.id),
    ).toEqual(["req-list"]);
    expect(
      projectDelivery({
        ...baseInput(),
        requirements: {
          "req-1": {
            ...requirement,
            state: "spec_ready",
            confirmed_revision: null,
            latest_run_id: null,
          },
        },
        runs: {},
      }).nodes.map((node) => node.id),
    ).toEqual(["req-list"]);
  });

  it("已确认但未启动时只显示确定需求摘要，不复制规格/澄清/确认", () => {
    const projection = projectDelivery({
      ...baseInput(),
      requirements: {
        "req-1": { ...requirement, latest_run_id: null },
      },
      runs: {},
    });
    expect(projection.nodes.map((node) => node.type)).toEqual([
      "requirement_list",
      "requirement_summary",
    ]);
  });

  it("WorkPlan 只连接根任务，依赖与质量链各只有一套语义", () => {
    const plan = buildDemoPlan("plan-1", "run-1", 1);
    const projection = projectDelivery({
      ...baseInput(),
      plans: { "run-1": plan },
    });
    const types = projection.nodes.map((node) => node.type);
    expect(types).not.toEqual(
      expect.arrayContaining([
        "source_ref",
        "clarification",
        "spec",
        "confirmation",
      ]),
    );
    expect(types).toEqual(
      expect.arrayContaining([
        "requirement_summary",
        "run",
        "work_plan",
        "work_item",
        "diff",
        "validation",
        "review",
        "publication",
      ]),
    );
    expect(types).not.toContain("diagnostics");

    const roots = plan.items.filter((item) => item.depends_on.length === 0);
    const planEdges = projection.edges.filter(
      (edge) => edge.source === deliveryNodeId.plan(run.id),
    );
    expect(planEdges.map((edge) => edge.target).sort()).toEqual(
      roots.map((item) => deliveryNodeId.workItem(item.id)).sort(),
    );
    expect(new Set(planEdges.map((edge) => edge.sourceHandle)).size).toBe(
      roots.length,
    );

    const dependencyEdges = projection.edges.filter((edge) =>
      plan.items.some(
        (item) =>
          edge.target === deliveryNodeId.workItem(item.id) &&
          item.depends_on.some(
            (dependency) => edge.source === deliveryNodeId.workItem(dependency),
          ),
      ),
    );
    expect(dependencyEdges).toHaveLength(
      plan.items.reduce((count, item) => count + item.depends_on.length, 0),
    );

    expect(projection.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: deliveryNodeId.diff(run.id),
          target: deliveryNodeId.validation(run.id),
        }),
        expect.objectContaining({
          source: deliveryNodeId.validation(run.id),
          target: deliveryNodeId.review(run.id),
        }),
        expect.objectContaining({
          source: deliveryNodeId.review(run.id),
          target: deliveryNodeId.publication(run.id),
        }),
      ]),
    );
  });

  it("分层布局保持 48px 同层间距和至少 112px 层间距", () => {
    const plan = buildDemoPlan("plan-1", "run-1", 1);
    const layout = layoutWorkItems(plan.items);
    expect(layout.issues).toEqual([]);
    expect(layout.levels.map((level) => level.length)).toEqual([2, 1, 1]);
    const first = layout.levels[0];
    const firstBottom = layout.positions[first[0].id].y + 208;
    expect(layout.positions[first[1].id].y - firstBottom).toBe(TASK_LANE_GAP);
    const level0X = layout.positions[first[0].id].x;
    const level1X = layout.positions[layout.levels[1][0].id].x;
    expect(level1X - level0X - TASK_NODE_WIDTH).toBe(TASK_LEVEL_GAP);
  });

  it("相同 revision 的状态更新不改变任务坐标", () => {
    const plan = buildDemoPlan("plan-1", "run-1", 1);
    const before = layoutWorkItems(plan.items).positions;
    const after = layoutWorkItems(
      plan.items.map((item, index) => ({
        ...item,
        status: index === 0 ? "running" : item.status,
        attempts:
          index === 0
            ? [
                {
                  index: 1,
                  kind: "implementation",
                  model: "mock",
                  upgraded: false,
                  status: "running",
                  summary: null,
                  started_at: "2026-01-01T00:00:00.000Z",
                  finished_at: null,
                },
              ]
            : item.attempts,
      })),
    ).positions;
    expect(after).toEqual(before);
  });

  it("环或缺失依赖只显示计划无效节点，不绘制任务", () => {
    const plan = buildDemoPlan("plan-1", "run-1", 1);
    plan.items = plan.items.map((item, index) =>
      index === 0 ? { ...item, depends_on: [plan.items.at(-1)!.id] } : item,
    );
    plan.validation = { ok: false, issues: ["计划依赖存在环"] };
    const projection = projectDelivery({
      ...baseInput(),
      plans: { "run-1": plan },
    });
    expect(projection.nodes.some((node) => node.type === "plan_invalid")).toBe(
      true,
    );
    expect(projection.nodes.some((node) => node.type === "work_item")).toBe(
      false,
    );
  });

  it("不信任持久化 ok 标记，缺失合并任务时仍拒绝绘图", () => {
    const plan = buildDemoPlan("plan-1", "run-1", 1);
    plan.items = plan.items.filter((item) => item.kind !== "merge_task");
    plan.validation = { ok: true, issues: [] };
    const projection = projectDelivery({
      ...baseInput(),
      plans: { "run-1": plan },
    });
    expect(projection.nodes.some((node) => node.type === "plan_invalid")).toBe(
      true,
    );
    expect(projection.nodes.some((node) => node.type === "work_item")).toBe(
      false,
    );
    expect(projection.edges.some((edge) => edge.source.startsWith("wi:"))).toBe(
      false,
    );
  });

  it("诊断按需出现；危险操作连接到真实来源阶段", () => {
    const action: PendingAction = {
      id: "act-1",
      kind: "force_deliver_unreviewed",
      run_id: run.id,
      requirement_id: requirement.id,
      title: "未经审核交付",
      impact: "",
      irreversible: true,
      state: "awaiting",
      result: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const projection = projectDelivery({
      ...baseInput(),
      diagnosticsRunId: run.id,
      actions: { [action.id]: action },
    });
    expect(projection.nodes.some((node) => node.type === "diagnostics")).toBe(
      true,
    );
    expect(projection.edges).toContainEqual(
      expect.objectContaining({
        source: deliveryNodeId.review(run.id),
        target: deliveryNodeId.actionConfirmation(action.id),
      }),
    );
  });
});

describe("layoutWorkItems 异常保护", () => {
  it("缺失依赖产生确定性问题", () => {
    const item: WorkItem = {
      id: "one",
      plan_id: "plan",
      kind: "work_item",
      title: "任务",
      position: 1,
      depends_on: ["missing"],
      scope_hint: "src/**",
      scenario_ids: [],
      verification_target: "test",
      batch: 0,
      status: "pending",
      attempts: [],
      artifact_summary: null,
      conflict_resolution: null,
    };
    expect(layoutWorkItems([item]).issues[0]).toContain("依赖不存在");
  });
});

describe("runLocateTarget", () => {
  it("活动工作项优先，与阶段无关", () => {
    expect(runLocateTarget(run, "wi-9")).toEqual({
      nodeId: deliveryNodeId.workItem("wi-9"),
      label: "定位当前任务",
    });
    expect(
      runLocateTarget({ ...run, phase: "reviewing" }, "wi-9")?.nodeId,
    ).toBe(deliveryNodeId.workItem("wi-9"));
  });

  it("validating / reviewing / publishing 映射到对应质量节点", () => {
    expect(runLocateTarget({ ...run, phase: "validating" }, null)).toEqual({
      nodeId: deliveryNodeId.validation(run.id),
      label: "定位验证",
    });
    expect(runLocateTarget({ ...run, phase: "reviewing" }, null)).toEqual({
      nodeId: deliveryNodeId.review(run.id),
      label: "定位审核",
    });
    expect(runLocateTarget({ ...run, phase: "publishing" }, null)).toEqual({
      nodeId: deliveryNodeId.publication(run.id),
      label: "定位发布",
    });
  });

  it("其余阶段且无活动工作项时不提供定位", () => {
    expect(runLocateTarget({ ...run, phase: "queued" }, null)).toBeNull();
    expect(runLocateTarget({ ...run, phase: "executing" }, null)).toBeNull();
    expect(runLocateTarget({ ...run, phase: "terminal" }, null)).toBeNull();
  });
});
