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
});
