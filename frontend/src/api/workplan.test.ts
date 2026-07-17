import { describe, expect, it } from "vitest";
import { buildDemoPlan } from "./mock/demoContent";
import { planEdgeKind, validateWorkPlan } from "./workplan";
import { DEMO_SCENARIOS } from "./mock/demoContent";
import type { WorkItem } from "./types";

function item(
  partial: Partial<WorkItem> & Pick<WorkItem, "id" | "title">,
): WorkItem {
  return {
    plan_id: "plan-t",
    kind: "work_item",
    position: 1,
    depends_on: [],
    scope_hint: "",
    scenario_ids: [],
    verification_target: "",
    batch: 0,
    status: "pending",
    attempts: [],
    artifact_summary: null,
    conflict_resolution: null,
    ...partial,
  };
}

describe("validateWorkPlan（PRD-RUN-005/006）", () => {
  it("演示计划通过校验：并行批 + 合并任务 + 串行收尾 + 场景全覆盖", () => {
    const plan = buildDemoPlan("plan-t", "run-t", 1);
    expect(plan.validation.ok).toBe(true);
    expect(validateWorkPlan(plan.items, DEMO_SCENARIOS).issues).toEqual([]);
  });

  it("依赖环被拒绝", () => {
    const items = [
      item({
        id: "a",
        title: "A",
        depends_on: ["b"],
        scenario_ids: ["SC-1", "SC-2"],
      }),
      item({ id: "b", title: "B", depends_on: ["a"], batch: 1 }),
    ];
    const report = validateWorkPlan(items, DEMO_SCENARIOS);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.includes("环"))).toBe(true);
  });

  it("并行批缺少合并任务 / 合并任务未依赖批内全部项被拒绝", () => {
    const noMerge = [
      item({ id: "a", title: "A", position: 1, scenario_ids: ["SC-1"] }),
      item({ id: "b", title: "B", position: 2, scenario_ids: ["SC-2"] }),
    ];
    expect(
      validateWorkPlan(noMerge, DEMO_SCENARIOS).issues.some((issue) =>
        issue.includes("必须有且仅有一个合并任务"),
      ),
    ).toBe(true);
    const partialMerge = [
      ...noMerge,
      item({
        id: "m",
        title: "合并",
        kind: "merge_task",
        position: 3,
        depends_on: ["a"],
      }),
    ];
    expect(
      validateWorkPlan(partialMerge, DEMO_SCENARIOS).issues.some((issue) =>
        issue.includes("未依赖批内工作项"),
      ),
    ).toBe(true);
  });

  it("同层超过三个并行 / 批内相互依赖被拒绝", () => {
    const four = ["a", "b", "c", "d"].map((id, index) =>
      item({
        id,
        title: id,
        position: index + 1,
        scenario_ids: ["SC-1", "SC-2"],
      }),
    );
    expect(
      validateWorkPlan(four, DEMO_SCENARIOS).issues.some((issue) =>
        issue.includes("上限 3"),
      ),
    ).toBe(true);
    const innerDep = [
      item({ id: "a", title: "A", position: 1, scenario_ids: ["SC-1"] }),
      item({
        id: "b",
        title: "B",
        position: 2,
        depends_on: ["a"],
        scenario_ids: ["SC-2"],
      }),
      item({
        id: "m",
        title: "合并",
        kind: "merge_task",
        position: 3,
        depends_on: ["a", "b"],
      }),
    ];
    expect(
      validateWorkPlan(innerDep, DEMO_SCENARIOS).issues.some((issue) =>
        issue.includes("相互依赖"),
      ),
    ).toBe(true);
  });

  it("验收场景未覆盖被拒绝", () => {
    const items = [item({ id: "a", title: "A", scenario_ids: ["SC-1"] })];
    const report = validateWorkPlan(items, DEMO_SCENARIOS);
    expect(report.issues.some((issue) => issue.includes("SC-2"))).toBe(true);
  });

  it("依赖边类型：合并 / 串行 / 阻断（FE-RUN-004）", () => {
    const work = item({ id: "a", title: "A" });
    const merge = item({ id: "m", title: "M", kind: "merge_task" });
    expect(planEdgeKind(work, merge)).toBe("merge");
    expect(planEdgeKind(merge, work)).toBe("serial");
    expect(planEdgeKind({ ...work, status: "blocked" }, merge)).toBe("blocked");
  });
});
