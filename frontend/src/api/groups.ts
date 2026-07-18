import type { Requirement, Run } from "./types";

/**
 * 需求列表分组投影（FE-DELIVERY-002、01 §8.1，纯函数）：
 * 分组由 RequirementState 与关联最新 Run 联合投影。
 */
export type RequirementGroupKey = "queued" | "active" | "blocked" | "history";

export const REQUIREMENT_GROUP_LABELS: Record<RequirementGroupKey, string> = {
  queued: "执行队列",
  active: "进行中",
  blocked: "阻断",
  history: "历史",
};

/** 需求工作台只接收曾经确认的需求；历史默认置底。 */
export const REQUIREMENT_GROUP_ORDER: RequirementGroupKey[] = [
  "queued",
  "active",
  "blocked",
  "history",
];

export function groupRequirement(
  requirement: Requirement,
  latestRun: Run | null,
): RequirementGroupKey | null {
  if (latestRun) {
    if (latestRun.phase === "blocked") return "blocked";
    if (latestRun.phase !== "terminal") return "active";
    return "history";
  }
  if (
    (requirement.state === "confirmed" || requirement.state === "queued") &&
    requirement.confirmed_revision !== null
  ) {
    return "queued";
  }
  if (requirement.state === "cancelled" || requirement.state === "superseded") {
    return requirement.confirmed_revision !== null ? "history" : null;
  }
  return null;
}

export type GroupedRequirements = {
  key: RequirementGroupKey;
  label: string;
  items: Requirement[];
};

export function groupRequirements(
  requirements: Requirement[],
  runsById: Record<string, Run>,
): GroupedRequirements[] {
  const groups = new Map<RequirementGroupKey, Requirement[]>();
  const sorted = [...requirements].sort((a, b) => {
    // 排队组内按 queue_position；其余按创建时间
    const positionA = a.queue_position ?? Number.MAX_SAFE_INTEGER;
    const positionB = b.queue_position ?? Number.MAX_SAFE_INTEGER;
    if (positionA !== positionB) return positionA - positionB;
    return a.created_at.localeCompare(b.created_at);
  });
  for (const requirement of sorted) {
    const latestRun = requirement.latest_run_id
      ? (runsById[requirement.latest_run_id] ?? null)
      : null;
    const key = groupRequirement(requirement, latestRun);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(requirement);
    groups.set(key, list);
  }
  return REQUIREMENT_GROUP_ORDER.filter((key) => groups.has(key)).map(
    (key) => ({
      key,
      label: REQUIREMENT_GROUP_LABELS[key],
      items: groups.get(key)!,
    }),
  );
}
