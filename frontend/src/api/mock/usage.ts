import { evaluateRunBudget, formatTokens, summarizeTokens } from "../usage";
import type {
  DomainEventPayload,
  EventAggregateType,
  EventType,
  ModelRole,
  UsageEntry,
  UsageState,
} from "../types";

type Emit = <T extends EventType>(
  aggregateType: EventAggregateType,
  aggregateId: string,
  eventType: T,
  payload: DomainEventPayload[T],
) => void;

const isoAtDaysAgo = (days: number) => {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
};

const roles: ModelRole[] = [
  "qa",
  "clarifier",
  "planner",
  "implementer",
  "reviewer",
];

/** 稳定且跨 365 天分布的展示数据；缓存不计入总 Token。 */
function demoEntries(): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (let index = 0; index < 118; index += 1) {
    const large = index % 3 !== 0;
    const run = index % 4 === 0 ? null : `demo-run-${(index % 8) + 1}`;
    entries.push({
      id: `usage-${index + 1}`,
      run_id: run,
      occurred_at: isoAtDaysAgo((index * 3 + (index % 5) * 11) % 365),
      role: roles[index % roles.length],
      provider_id: large ? "fake-large" : "fake-chat",
      model_id: large ? "fake-large-a" : "fake-chat-pro",
      input_tokens: index === 117 ? null : 18_000 + (index % 13) * 4_700,
      output_tokens: index === 117 ? null : 2_800 + (index % 7) * 1_150,
      cache_tokens: index % 9 === 0 ? null : 3_000 + (index % 10) * 900,
      cost_usd: index % 17 === 0 ? null : 0.32 + (index % 11) * 0.18,
    });
  }
  return entries;
}

export class UsageModule {
  private usage: UsageState = { entries: demoEntries() };
  private recordedCounter = 0;

  constructor(private readonly deps: { emit: Emit }) {}

  snapshotState(): UsageState {
    return this.usage;
  }

  append(entry: UsageEntry) {
    this.usage = { entries: [...this.usage.entries, entry] };
    this.deps.emit("usage", "project", "usage.updated", {
      usage: this.usage,
    });
  }

  recordRunUsage(input: {
    run_id: string;
    role: ModelRole;
    input_tokens: number;
    output_tokens: number;
    cache_tokens: number | null;
    cost_usd: number | null;
    budget_usd: number;
  }) {
    const large = input.role !== "qa" && input.role !== "clarifier";
    this.append({
      id: `run-usage-${++this.recordedCounter}`,
      run_id: input.run_id,
      occurred_at: new Date().toISOString(),
      role: input.role,
      provider_id: large ? "fake-large" : "fake-chat",
      model_id: large ? "fake-large-a" : "fake-chat-pro",
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      cache_tokens: input.cache_tokens,
      cost_usd: input.cost_usd,
    });
    return evaluateRunBudget(this.usage, input.run_id, input.budget_usd);
  }

  summaryLines(): string[] {
    const summary = summarizeTokens(this.usage);
    const incomplete = summary.incomplete_entries
      ? ` · ${summary.incomplete_entries} 条不完整`
      : "";
    return [
      `总 Token 未缓存 ${formatTokens(summary.known_total)} · 缓存 ${formatTokens(summary.cache_tokens)}${incomplete}`,
      `对话未缓存 ${formatTokens(summary.conversation_tokens)} · 任务未缓存 ${formatTokens(summary.task_tokens)}`,
      `最近活跃：${new Date().toLocaleDateString("zh-CN")}`,
    ];
  }
}
