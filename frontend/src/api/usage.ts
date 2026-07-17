import type { UsageEntry, UsageState } from "./types";

/**
 * 用量展示规则（PRD-USAGE-001～003，纯函数）：
 * 未知 token 或价格明确显示"不完整"，不得估造；
 * 软阈值只产生告警，不自动暂停/换模。
 */

/** 单条用量是否完整（token 与价格全部已知） */
export function usageEntryComplete(entry: UsageEntry): boolean {
  return (
    entry.input_tokens !== null &&
    entry.output_tokens !== null &&
    entry.cache_tokens !== null &&
    entry.cost_usd !== null
  );
}

export function formatTokens(value: number | null): string {
  return value === null ? "不完整" : value.toLocaleString("en-US");
}

export function formatCost(value: number | null): string {
  return value === null ? "不完整" : `$${value.toFixed(4)}`;
}

export function totalCost(usage: UsageState): number | null {
  let sum = 0;
  for (const entry of usage.entries) {
    if (entry.cost_usd === null) return null; // 任一未知 → 整体不完整（不估造）
    sum += entry.cost_usd;
  }
  return sum;
}

/** 已知价格小计（未知价格条目不计入也不估造；用于软阈值评估） */
export function knownCostSubtotal(usage: UsageState): number {
  return usage.entries.reduce((sum, entry) => sum + (entry.cost_usd ?? 0), 0);
}

export type SoftThresholdAlert = {
  scope: "global";
  ratio: number;
  total: number;
  threshold: number;
};

/** 全局软阈值告警（已知价格小计 ≥80% 触发；软告警不自动暂停/换模，PRD-USAGE-002） */
export function evaluateSoftThreshold(
  usage: UsageState,
): SoftThresholdAlert | null {
  if (usage.soft_threshold_usd <= 0) return null;
  const total = knownCostSubtotal(usage);
  const ratio = total / usage.soft_threshold_usd;
  if (ratio < 0.8) return null;
  return {
    scope: "global",
    ratio,
    total,
    threshold: usage.soft_threshold_usd,
  };
}
