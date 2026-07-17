import { describe, expect, it } from "vitest";
import type { UsageEntry, UsageState } from "./types";
import {
  evaluateSoftThreshold,
  formatCost,
  formatTokens,
  totalCost,
  usageEntryComplete,
} from "./usage";

const entry = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  id: "u-x",
  run_id: null,
  role: "qa",
  provider_id: "fake-chat",
  model_id: "fake-chat-pro",
  input_tokens: 100,
  output_tokens: 50,
  cache_tokens: 10,
  cost_usd: 1,
  ...overrides,
});

describe("用量完整性展示规则（PRD-USAGE-003）", () => {
  it("任一 token 或价格未知即为不完整", () => {
    expect(usageEntryComplete(entry())).toBe(true);
    expect(usageEntryComplete(entry({ cache_tokens: null }))).toBe(false);
    expect(usageEntryComplete(entry({ cost_usd: null }))).toBe(false);
  });

  it("未知显示「不完整」，不估造", () => {
    expect(formatTokens(null)).toBe("不完整");
    expect(formatCost(null)).toBe("不完整");
    expect(formatTokens(1234)).toBe("1,234");
    expect(formatCost(0.5)).toBe("$0.5000");
  });

  it("任一价格未知时合计为 null（整体不完整）", () => {
    const usage: UsageState = {
      soft_threshold_usd: 25,
      entries: [entry({ cost_usd: 2 }), entry({ cost_usd: null })],
    };
    expect(totalCost(usage)).toBeNull();
    expect(totalCost({ ...usage, entries: [entry({ cost_usd: 2 })] })).toBe(2);
  });
});

describe("软阈值告警（PRD-USAGE-002）", () => {
  it("≥80% 触发告警", () => {
    const usage: UsageState = {
      soft_threshold_usd: 25,
      entries: [entry({ cost_usd: 20 })],
    };
    const alert = evaluateSoftThreshold(usage);
    expect(alert?.ratio).toBeCloseTo(0.8);
    expect(alert?.total).toBe(20);
  });

  it("低于 80% 不触发", () => {
    expect(
      evaluateSoftThreshold({
        soft_threshold_usd: 25,
        entries: [entry({ cost_usd: 10 })],
      }),
    ).toBeNull();
  });

  it("阈值评估基于已知价格小计（未知价格条目不计入）", () => {
    // 已知小计 20 / 25 = 80% → 触发；未知价格条目不改变结果
    const withUnknown = evaluateSoftThreshold({
      soft_threshold_usd: 25,
      entries: [entry({ cost_usd: 20 }), entry({ cost_usd: null })],
    });
    expect(withUnknown?.total).toBe(20);
    expect(withUnknown?.ratio).toBeCloseTo(0.8);
  });
});
