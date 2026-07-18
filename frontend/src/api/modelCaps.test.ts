import { describe, expect, it } from "vitest";
import {
  capabilityCheckMessage,
  checkRoleCapability,
  requiredCapabilities,
} from "./modelCaps";
import type { ModelCapability } from "./types";

const full: ModelCapability = {
  text: "supported",
  image: "supported",
  streaming: "supported",
  tools: "supported",
  structured_output: "supported",
  long_context: "supported",
};

describe("角色能力要求（PRD-MODEL-004）", () => {
  it("所有角色要求工具调用", () => {
    for (const role of [
      "qa",
      "clarifier",
      "planner",
      "implementer",
      "reviewer",
    ] as const) {
      expect(requiredCapabilities(role)).toContain("tools");
    }
  });

  it("implementer/reviewer 另要求结构化输出与长上下文", () => {
    expect(requiredCapabilities("implementer")).toEqual([
      "tools",
      "structured_output",
      "long_context",
    ]);
    expect(requiredCapabilities("reviewer")).toEqual([
      "tools",
      "structured_output",
      "long_context",
    ]);
    expect(requiredCapabilities("qa")).toEqual(["tools"]);
  });
});

describe("能力校验", () => {
  it("全支持通过", () => {
    expect(checkRoleCapability("implementer", full).ok).toBe(true);
  });

  it("不支持工具调用的模型不能承担任何角色", () => {
    const noTools: ModelCapability = { ...full, tools: "unsupported" };
    for (const role of [
      "qa",
      "clarifier",
      "planner",
      "implementer",
      "reviewer",
    ] as const) {
      const check = checkRoleCapability(role, noTools);
      expect(check.ok).toBe(false);
      expect(check.missing).toContain("tools");
    }
  });

  it("能力未知按不满足处理并单独列出", () => {
    const unknownStructured: ModelCapability = {
      ...full,
      structured_output: "unknown",
    };
    const check = checkRoleCapability("reviewer", unknownStructured);
    expect(check.ok).toBe(false);
    expect(check.unknown).toEqual(["structured_output"]);
    // qa 只要求工具调用，不受影响
    expect(checkRoleCapability("qa", unknownStructured).ok).toBe(true);
  });

  it("阻止消息包含缺失与未知能力", () => {
    const message = capabilityCheckMessage("implementer", "FakeLarge B", {
      ok: false,
      missing: ["tools"],
      unknown: ["long_context"],
    });
    expect(message).toContain("FakeLarge B");
    expect(message).toContain("工具调用");
    expect(message).toContain("长上下文");
    expect(message).toContain("保存已被阻止");
  });

  it("仅能力未知时只列未知段，不混入缺失段", () => {
    const check = checkRoleCapability("reviewer", {
      ...full,
      structured_output: "unknown",
    });
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([]);
    const message = capabilityCheckMessage("reviewer", "FakeSmall", check);
    expect(message).not.toContain("缺失能力");
    expect(message).toContain("能力未知：结构化输出");
  });

  it("缺失与未知同时存在时分段列出且 qa 不受长上下文影响", () => {
    const mixed: ModelCapability = {
      ...full,
      tools: "unsupported",
      long_context: "unknown",
    };
    const check = checkRoleCapability("implementer", mixed);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["tools"]);
    expect(check.unknown).toEqual(["long_context"]);
    const message = capabilityCheckMessage("implementer", "Mixed", check);
    expect(message).toContain("缺失能力：工具调用");
    expect(message).toContain("能力未知：长上下文");
    // qa 只要求工具调用：仅工具缺失，长上下文未知不进入清单
    const qaCheck = checkRoleCapability("qa", mixed);
    expect(qaCheck.missing).toEqual(["tools"]);
    expect(qaCheck.unknown).toEqual([]);
  });
});
