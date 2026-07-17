import type {
  AcceptanceScenario,
  PlanValidationReport,
  WorkItem,
} from "./types";

/**
 * WorkPlan DAG 校验（PRD-RUN-005/006，纯函数）：
 * - 依赖引用存在且无环；
 * - 同批工作项互不依赖（并行安全），同层最多三个并行；
 * - 每个 ≥2 项的并行批之后必须有且仅有一个显式合并任务，依赖批内全部工作项；
 * - 验收场景覆盖：规格每个场景至少被一个工作项引用。
 */
export function validateWorkPlan(
  items: WorkItem[],
  scenarios: AcceptanceScenario[],
): PlanValidationReport {
  const issues: string[] = [];
  const byId = new Map(items.map((item) => [item.id, item]));

  // 依赖引用存在性
  for (const item of items) {
    for (const dep of item.depends_on) {
      if (!byId.has(dep))
        issues.push(`${item.title}：依赖不存在的工作项 ${dep}`);
    }
  }

  // 环检测（拓扑排序）
  const indegree = new Map<string, number>();
  for (const item of items) {
    indegree.set(
      item.id,
      item.depends_on.filter((dep) => byId.has(dep)).length,
    );
  }
  const queue = items
    .filter((item) => (indegree.get(item.id) ?? 0) === 0)
    .map((item) => item.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const item of items) {
      if (!item.depends_on.includes(id)) continue;
      const next = (indegree.get(item.id) ?? 0) - 1;
      indegree.set(item.id, next);
      if (next === 0) queue.push(item.id);
    }
  }
  if (visited < items.length) issues.push("计划依赖存在环");

  // 并行批规则
  const batches = new Map<number, WorkItem[]>();
  for (const item of items.filter((entry) => entry.kind === "work_item")) {
    const list = batches.get(item.batch) ?? [];
    list.push(item);
    batches.set(item.batch, list);
  }
  for (const [batch, members] of batches) {
    if (members.length > 3) {
      issues.push(
        `并行批 ${batch + 1} 含 ${members.length} 个工作项（上限 3）`,
      );
    }
    const memberIds = new Set(members.map((member) => member.id));
    for (const member of members) {
      if (member.depends_on.some((dep) => memberIds.has(dep))) {
        issues.push(`并行批 ${batch + 1} 内存在相互依赖（${member.title}）`);
      }
    }
    const mergeTasks = items.filter(
      (item) => item.kind === "merge_task" && item.batch === batch,
    );
    if (members.length >= 2) {
      if (mergeTasks.length !== 1) {
        issues.push(
          `并行批 ${batch + 1}（${members.length} 项）后必须有且仅有一个合并任务`,
        );
      } else {
        const merge = mergeTasks[0];
        for (const member of members) {
          if (!merge.depends_on.includes(member.id)) {
            issues.push(
              `合并任务 ${merge.title} 未依赖批内工作项 ${member.title}`,
            );
          }
        }
        const maxPosition = Math.max(
          ...members.map((member) => member.position),
        );
        if (merge.position <= maxPosition) {
          issues.push(`合并任务 ${merge.title} 必须排在并行批之后`);
        }
      }
    } else if (mergeTasks.length > 0) {
      issues.push(`串行批 ${batch + 1} 不需要合并任务`);
    }
  }

  // 场景覆盖
  const covered = new Set(
    items
      .filter((item) => item.kind === "work_item")
      .flatMap((item) => item.scenario_ids),
  );
  for (const scenario of scenarios) {
    if (!covered.has(scenario.id)) {
      issues.push(`验收场景 ${scenario.id} 未被任何工作项覆盖`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/** 计划依赖边类型（FE-RUN-004：不只靠颜色区分） */
export type PlanEdgeKind = "serial" | "merge" | "blocked";

export function planEdgeKind(source: WorkItem, target: WorkItem): PlanEdgeKind {
  if (source.status === "blocked" || target.status === "blocked") {
    return "blocked";
  }
  return target.kind === "merge_task" ? "merge" : "serial";
}
