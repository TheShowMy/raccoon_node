import { describe, expect, it } from "vitest";
import { isSemanticChange, semanticHash } from "./specHash";
import { demoSpec } from "./mock/demoContent";

const base = demoSpec("演示需求", "工作流执行语义");

describe("semanticHash（PRD-SPEC-007）", () => {
  it("相同规格哈希稳定；语义字段变化哈希变化", () => {
    expect(semanticHash(base)).toBe(semanticHash(structuredClone(base)));
    const changed = structuredClone(base);
    changed.goal = "改写目标";
    expect(semanticHash(changed)).not.toBe(semanticHash(base));
  });

  it("场景与约束参与哈希（含稳定 ID 与来源）", () => {
    const scenarioChanged = structuredClone(base);
    scenarioChanged.scenarios[0].then = "改变 Then";
    expect(isSemanticChange(base, scenarioChanged)).toBe(true);
    const constraintChanged = structuredClone(base);
    constraintChanged.constraints[0].text = "改变约束文本";
    expect(isSemanticChange(base, constraintChanged)).toBe(true);
  });

  it("证据修正是非语义修改：不触发确认撤销", () => {
    const evidenceOnly = structuredClone(base);
    evidenceOnly.evidence = ["补充一条证据引用"];
    expect(isSemanticChange(base, evidenceOnly)).toBe(false);
    expect(semanticHash(evidenceOnly)).toBe(semanticHash(base));
  });

  it("首尾空白不影响哈希（规范化）", () => {
    const padded = structuredClone(base);
    padded.goal = `  ${base.goal}  `;
    expect(semanticHash(padded)).toBe(semanticHash(base));
  });
});
