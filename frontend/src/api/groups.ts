import type { Requirement, Run } from "./types";

/**
 * 需求列表分组投影（FE-DELIVERY-002、01 §8.1，纯函数）：
 * 分组由 RequirementState 与关联最新 Run 联合投影。
 */
export type RequirementGroupKey =
  | "drafting"
  | "pending_confirm"
  | "queued"
  | "running"
  | "delivered"
  | "blocked"
  | "closed";

export const REQUIREMENT_GROUP_LABELS: Record<RequirementGroupKey, string> = {
  drafting: "草拟",
  pending_confirm: "待确认",
  queued: "排队",
  running: "运行",
  delivered: "交付",
  blocked: "阻断",
  closed: "已取消",
};

/** 六分组展示顺序（closed 置于底部，不参与队列语义） */
export const REQUIREMENT_GROUP_ORDER: RequirementGroupKey[] = [
  "drafting",
  "pending_confirm",
  "queued",
  "running",
  "delivered",
  "blocked",
  "closed",
];

const TERMINAL_OUTCOME_TO_GROUP: Partial<
  Record<NonNullable<Run["outcome"]>, RequirementGroupKey>
> = {
  delivered: "delivered",
  blocked: "blocked",
  failed: "blocked",
};

export function groupRequirement(
  requirement: Requirement,
  latestRun: Run | null,
): RequirementGroupKey {
  if (requirement.state === "cancelled" || requirement.state === "superseded") {
    return "closed";
  }
  if (latestRun) {
    // 关联 Run 非终态 → 运行（含 waiting_workspace，PRD §8.1）
    if (latestRun.phase !== "terminal") return "running";
    const terminalGroup = latestRun.outcome
      ? TERMINAL_OUTCOME_TO_GROUP[latestRun.outcome]
      : undefined;
    // cancelled 的 Run 不决定分组（语义修改取消后需求回 spec_ready，PRD-SPEC-007）
    if (terminalGroup) return terminalGroup;
  }
  switch (requirement.state) {
    case "drafting":
    case "clarifying":
      return "drafting";
    case "spec_ready":
      return "pending_confirm";
    case "confirmed":
    case "queued":
      return "queued";
  }
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
