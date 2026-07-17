import type { RequirementSpec } from "./types";

/**
 * 规格语义哈希（PRD-SPEC-007、BE-SPEC-003）：
 * 只对语义字段（目标/价值/范围/场景/约束/非目标/风险/假设）做稳定序列化，
 * evidence 不参与——证据修正是非语义修改，不撤销确认、不取消 Run。
 */
export function semanticHash(spec: RequirementSpec): string {
  const semantic = {
    goal: spec.goal.trim(),
    user_value: spec.user_value.trim(),
    in_scope: spec.in_scope.map((line) => line.trim()),
    out_of_scope: spec.out_of_scope.map((line) => line.trim()),
    scenarios: spec.scenarios.map((scenario) => [
      scenario.id,
      scenario.given.trim(),
      scenario.when.trim(),
      scenario.then.trim(),
    ]),
    constraints: spec.constraints.map((constraint) => [
      constraint.id,
      constraint.text.trim(),
      constraint.source.kind,
      constraint.source.ref,
    ]),
    non_goals: spec.non_goals.map((line) => line.trim()),
    risks: spec.risks.map((line) => line.trim()),
    assumptions: spec.assumptions.map((line) => line.trim()),
  };
  const text = JSON.stringify(semantic);
  // FNV-1a 32bit：稳定、无依赖；后端阶段由契约哈希替换
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 是否语义修改（true → 撤销确认 + 取消未终态 Run；false → 证据修正不触发） */
export function isSemanticChange(
  previous: RequirementSpec,
  next: RequirementSpec,
): boolean {
  return semanticHash(previous) !== semanticHash(next);
}
