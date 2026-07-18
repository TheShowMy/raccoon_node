import { describe, expect, it } from "vitest";
import type { UsageEntry, UsageState } from "./types";
import {
  buildDailyUsage,
  entryTokens,
  evaluateRunBudget,
  formatTokens,
  groupUsageByModel,
  summarizeTokens,
  usageEntryComplete,
} from "./usage";

const entry = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  id: "u-x",
  run_id: null,
  occurred_at: "2026-07-18T10:00:00Z",
  role: "qa",
  provider_id: "fake-chat",
  model_id: "fake-chat-pro",
  input_tokens: 100,
  output_tokens: 50,
  cache_tokens: 10,
  cost_usd: 1,
  ...overrides,
});

describe("用量统计口径", () => {
  it("总 Token 只包含输入与输出，缓存单独统计", () => {
    const usage: UsageState = {
      entries: [entry(), entry({ id: "task", run_id: "run-1" })],
    };
    expect(entryTokens(usage.entries[0])).toBe(150);
    expect(summarizeTokens(usage)).toEqual({
      known_total: 300,
      conversation_tokens: 150,
      task_tokens: 150,
      cache_tokens: 20,
      conversation_cache_tokens: 10,
      task_cache_tokens: 10,
      incomplete_entries: 0,
    });
  });

  it("长 Token 数按万、千万、亿缩写", () => {
    expect(formatTokens(9_999)).toBe("9,999");
    expect(formatTokens(28_700)).toBe("2.9万");
    expect(formatTokens(32_000_000)).toBe("3.2千万");
    expect(formatTokens(2_870_000_000)).toBe("28.7亿");
  });

  it("未知 Token 与费用保留不完整计数，不按零伪装完整", () => {
    const usage: UsageState = {
      entries: [entry(), entry({ input_tokens: null, cost_usd: null })],
    };
    expect(usageEntryComplete(usage.entries[1])).toBe(false);
    expect(summarizeTokens(usage).incomplete_entries).toBe(1);
    expect(groupUsageByModel(usage)[0].incomplete_cost_entries).toBe(1);
  });

  it("按模型聚合对话、任务、缓存、占比和已知费用", () => {
    const usage: UsageState = {
      entries: [entry(), entry({ id: "task", run_id: "run-1", cost_usd: 2 })],
    };
    expect(groupUsageByModel(usage)[0]).toMatchObject({
      total_tokens: 300,
      conversation_tokens: 150,
      task_tokens: 150,
      cache_tokens: 20,
      share: 1,
      known_cost_usd: 3,
    });
  });

  it("生成固定 365 天点阵并按日聚合分档", () => {
    const points = buildDailyUsage(
      { entries: [entry()] },
      365,
      new Date("2026-07-18T12:00:00Z"),
    );
    expect(points).toHaveLength(365);
    expect(points.at(-1)).toMatchObject({
      date: "2026-07-18",
      tokens: 150,
      level: 4,
    });
    expect(points[0].level).toBe(0);
  });
});

describe("任务预算", () => {
  it("只按 run_id 聚合已知费用，80% 触发软警告", () => {
    const usage: UsageState = {
      entries: [
        entry({ run_id: "run-1", cost_usd: 8 }),
        entry({ id: "unknown", run_id: "run-1", cost_usd: null }),
        entry({ id: "other", run_id: "run-2", cost_usd: 99 }),
      ],
    };
    expect(evaluateRunBudget(usage, "run-1", 10)).toMatchObject({
      known_cost_usd: 8,
      incomplete_entries: 1,
      ratio: 0.8,
      warning: true,
    });
  });
});
