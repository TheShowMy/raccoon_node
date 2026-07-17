import type {
  CapabilityName,
  CapabilitySupport,
  ModelCapability,
  ModelRole,
} from "./types";

/**
 * 模型角色能力校验（PRD-MODEL-004、BE-MODEL-004，纯函数）：
 * 所有角色必须支持工具调用（submit_* 均为工具调用）；
 * implementer/reviewer 另要求结构化输出与长上下文。
 * unknown 按不满足处理（保存前需探测或换模），并给出缺失能力清单。
 */

export const ROLE_LABELS: Record<ModelRole, string> = {
  qa: "问答",
  clarifier: "澄清",
  planner: "规划",
  implementer: "实现",
  reviewer: "审核",
};

export const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  text: "文本",
  image: "图片",
  streaming: "流式",
  tools: "工具调用",
  structured_output: "结构化输出",
  long_context: "长上下文",
};

export const SUPPORT_LABELS: Record<CapabilitySupport, string> = {
  supported: "支持",
  unsupported: "不支持",
  unknown: "未知",
};

/** 角色能力要求：工具调用全角色必需 */
export function requiredCapabilities(role: ModelRole): CapabilityName[] {
  const base: CapabilityName[] = ["tools"];
  if (role === "implementer" || role === "reviewer") {
    return [...base, "structured_output", "long_context"];
  }
  return base;
}

export type CapabilityCheck = {
  ok: boolean;
  missing: CapabilityName[];
  unknown: CapabilityName[];
};

export function checkRoleCapability(
  role: ModelRole,
  capabilities: ModelCapability,
): CapabilityCheck {
  const missing: CapabilityName[] = [];
  const unknown: CapabilityName[] = [];
  for (const name of requiredCapabilities(role)) {
    const support = capabilities[name];
    if (support === "unsupported") missing.push(name);
    else if (support === "unknown") unknown.push(name);
  }
  return { ok: missing.length === 0 && unknown.length === 0, missing, unknown };
}

export function capabilityCheckMessage(
  role: ModelRole,
  modelLabel: string,
  check: CapabilityCheck,
): string {
  const parts: string[] = [];
  if (check.missing.length > 0) {
    parts.push(
      `缺失能力：${check.missing.map((n) => CAPABILITY_LABELS[n]).join("、")}`,
    );
  }
  if (check.unknown.length > 0) {
    parts.push(
      `能力未知：${check.unknown.map((n) => CAPABILITY_LABELS[n]).join("、")}`,
    );
  }
  return `无法把 ${modelLabel} 配置为 ${ROLE_LABELS[role]}：${parts.join("；")}。保存已被阻止。`;
}
