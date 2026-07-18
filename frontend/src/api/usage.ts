import type { UsageEntry, UsageState } from "./types";

/** Token 总量只包含 input + output；缓存单独统计，避免重复计入。 */
export function entryTokens(entry: UsageEntry): number | null {
  if (entry.input_tokens === null || entry.output_tokens === null) return null;
  return entry.input_tokens + entry.output_tokens;
}

export function usageEntryComplete(entry: UsageEntry): boolean {
  return (
    entryTokens(entry) !== null &&
    entry.cache_tokens !== null &&
    entry.cost_usd !== null
  );
}

export function formatTokens(value: number | null): string {
  if (value === null) return "不完整";
  const magnitude = Math.abs(value);
  const formatLevel = (divisor: number, unit: string) =>
    `${new Intl.NumberFormat("zh-CN", {
      maximumFractionDigits: 1,
    }).format(value / divisor)}${unit}`;
  if (magnitude >= 100_000_000) return formatLevel(100_000_000, "亿");
  if (magnitude >= 10_000_000) return formatLevel(10_000_000, "千万");
  if (magnitude >= 10_000) return formatLevel(10_000, "万");
  return value.toLocaleString("zh-CN");
}

export function formatCost(value: number | null): string {
  return value === null ? "不完整" : `$${value.toFixed(4)}`;
}

export type TokenOverview = {
  known_total: number;
  conversation_tokens: number;
  task_tokens: number;
  cache_tokens: number;
  conversation_cache_tokens: number;
  task_cache_tokens: number;
  incomplete_entries: number;
};

export function summarizeTokens(usage: UsageState): TokenOverview {
  return usage.entries.reduce<TokenOverview>(
    (summary, entry) => {
      const tokens = entryTokens(entry);
      const cacheTokens = entry.cache_tokens;
      if (tokens === null || cacheTokens === null) {
        summary.incomplete_entries += 1;
      }
      if (entry.run_id === null) {
        summary.conversation_tokens += tokens ?? 0;
        summary.conversation_cache_tokens += cacheTokens ?? 0;
      } else {
        summary.task_tokens += tokens ?? 0;
        summary.task_cache_tokens += cacheTokens ?? 0;
      }
      summary.known_total += tokens ?? 0;
      summary.cache_tokens += cacheTokens ?? 0;
      return summary;
    },
    {
      known_total: 0,
      conversation_tokens: 0,
      task_tokens: 0,
      cache_tokens: 0,
      conversation_cache_tokens: 0,
      task_cache_tokens: 0,
      incomplete_entries: 0,
    },
  );
}

export type ModelUsageSummary = {
  key: string;
  provider_id: string;
  model_id: string;
  total_tokens: number;
  conversation_tokens: number;
  task_tokens: number;
  cache_tokens: number;
  share: number;
  known_cost_usd: number;
  incomplete_token_entries: number;
  incomplete_cost_entries: number;
};

export function groupUsageByModel(usage: UsageState): ModelUsageSummary[] {
  const total = summarizeTokens(usage).known_total;
  const groups = new Map<string, Omit<ModelUsageSummary, "share">>();
  for (const entry of usage.entries) {
    const key = `${entry.provider_id}/${entry.model_id}`;
    const group = groups.get(key) ?? {
      key,
      provider_id: entry.provider_id,
      model_id: entry.model_id,
      total_tokens: 0,
      conversation_tokens: 0,
      task_tokens: 0,
      cache_tokens: 0,
      known_cost_usd: 0,
      incomplete_token_entries: 0,
      incomplete_cost_entries: 0,
    };
    const tokens = entryTokens(entry);
    if (tokens === null) group.incomplete_token_entries += 1;
    else {
      group.total_tokens += tokens;
      if (entry.run_id === null) group.conversation_tokens += tokens;
      else group.task_tokens += tokens;
    }
    group.cache_tokens += entry.cache_tokens ?? 0;
    if (entry.cost_usd === null) group.incomplete_cost_entries += 1;
    else group.known_cost_usd += entry.cost_usd;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      share: total > 0 ? group.total_tokens / total : 0,
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);
}

export type DailyUsagePoint = {
  date: string;
  tokens: number;
  level: 0 | 1 | 2 | 3 | 4;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** 返回从 startDay 起固定天数的点阵；无记录的日期也保留。 */
export function buildDailyUsage(
  usage: UsageState,
  days = 365,
  endDate = new Date(),
): DailyUsagePoint[] {
  const daily = new Map<string, number>();
  for (const entry of usage.entries) {
    const tokens = entryTokens(entry);
    if (tokens === null) continue;
    const day = entry.occurred_at.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + tokens);
  }
  const end = new Date(
    Date.UTC(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth(),
      endDate.getUTCDate(),
    ),
  );
  const raw: Array<{ date: string; tokens: number }> = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - offset);
    const day = isoDay(date);
    raw.push({ date: day, tokens: daily.get(day) ?? 0 });
  }
  const nonZero = raw.map((point) => point.tokens).filter((value) => value > 0);
  const max = Math.max(0, ...nonZero);
  return raw.map((point) => ({
    ...point,
    level:
      point.tokens === 0 || max === 0
        ? 0
        : (Math.min(4, Math.max(1, Math.ceil((point.tokens / max) * 4))) as
            1 | 2 | 3 | 4),
  }));
}

export type RunBudgetStatus = {
  run_id: string;
  budget_usd: number;
  known_cost_usd: number;
  incomplete_entries: number;
  ratio: number;
  warning: boolean;
};

export function evaluateRunBudget(
  usage: UsageState,
  runId: string,
  budgetUsd: number,
): RunBudgetStatus {
  const entries = usage.entries.filter((entry) => entry.run_id === runId);
  const known = entries.reduce((sum, entry) => sum + (entry.cost_usd ?? 0), 0);
  const incomplete = entries.filter((entry) => entry.cost_usd === null).length;
  const ratio = budgetUsd > 0 ? known / budgetUsd : 0;
  return {
    run_id: runId,
    budget_usd: budgetUsd,
    known_cost_usd: known,
    incomplete_entries: incomplete,
    ratio,
    warning: budgetUsd > 0 && ratio >= 0.8,
  };
}
