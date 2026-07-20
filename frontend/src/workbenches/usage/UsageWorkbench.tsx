import { useEffect, useRef, useState } from "react";
import {
  buildDailyUsage,
  formatCost,
  formatTokens,
  groupUsageByModel,
  summarizeTokens,
} from "../../api/usage";
import { useDomainStore } from "../../store/domainStore";
import { ToolWorkbench, WorkbenchToolbar } from "../shared/ToolWorkbench";

function UsageMetric({
  label,
  uncached,
  cached,
}: {
  label: string;
  uncached: number;
  cached: number;
}) {
  return (
    <div className="usage-summary-metric">
      <span className="usage-summary-metric__label">{label}</span>
      <dl>
        <div>
          <dt>未缓存</dt>
          <dd>{formatTokens(uncached)}</dd>
        </div>
        <div>
          <dt>缓存</dt>
          <dd>{formatTokens(cached)}</dd>
        </div>
      </dl>
    </div>
  );
}

function monthLabels(points: ReturnType<typeof buildDailyUsage>) {
  return points.filter((point, index) => {
    if (index === 0) return true;
    return point.date.slice(0, 7) !== points[index - 1].date.slice(0, 7);
  });
}

function UsageHeatmap({
  daily,
  months,
}: {
  daily: ReturnType<typeof buildDailyUsage>;
  months: ReturnType<typeof buildDailyUsage>;
}) {
  const [activeDayIndex, setActiveDayIndex] = useState(
    Math.max(0, daily.length - 1),
  );
  const dayRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    setActiveDayIndex((index) =>
      Math.min(index, Math.max(0, daily.length - 1)),
    );
  }, [daily.length]);
  const moveDayFocus = (index: number) => {
    const next = Math.max(0, Math.min(daily.length - 1, index));
    setActiveDayIndex(next);
    requestAnimationFrame(() => dayRefs.current[next]?.focus());
  };
  const activeDay = daily[activeDayIndex];
  return (
    <>
      <div className="usage-heatmap-months" aria-hidden="true">
        {months.map((point) => (
          <span key={point.date}>{Number(point.date.slice(5, 7))}月</span>
        ))}
      </div>
      <div
        className="usage-heatmap"
        aria-label="最近 365 天每日 Token 点阵图"
        aria-describedby="usage-heatmap-help usage-heatmap-detail"
      >
        {daily.map((point, index) => (
          <button
            key={point.date}
            ref={(element) => {
              dayRefs.current[index] = element;
            }}
            type="button"
            className="usage-heatmap__day"
            data-level={point.level}
            tabIndex={index === activeDayIndex ? 0 : -1}
            title={`${point.date}：${formatTokens(point.tokens)} Token`}
            aria-label={`${point.date}，${formatTokens(point.tokens)} Token`}
            onFocus={() => setActiveDayIndex(index)}
            onMouseEnter={() => setActiveDayIndex(index)}
            onKeyDown={(event) => {
              const moves: Partial<Record<string, number>> = {
                ArrowUp: -1,
                ArrowDown: 1,
                ArrowLeft: -7,
                ArrowRight: 7,
              };
              if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                moveDayFocus(event.key === "Home" ? 0 : daily.length - 1);
                return;
              }
              const delta = moves[event.key];
              if (delta === undefined) return;
              event.preventDefault();
              moveDayFocus(index + delta);
            }}
          />
        ))}
      </div>
      <p id="usage-heatmap-help" className="usage-heatmap__help">
        Tab 进入点阵，方向键按日期或周移动。
      </p>
      <p
        id="usage-heatmap-detail"
        className="usage-heatmap__detail"
        aria-live="polite"
      >
        {activeDay
          ? `${activeDay.date} · ${formatTokens(activeDay.tokens)} Token`
          : "暂无每日用量"}
      </p>
      <div className="usage-heatmap-legend" aria-label="Token 活跃度图例">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <i key={level} data-level={level} />
        ))}
        <span>多</span>
      </div>
    </>
  );
}

export function UsageWorkbench() {
  const usage = useDomainStore((state) => state.usage);
  if (!usage) {
    return (
      <p className="tool-empty-state" role="status">
        用量数据加载中…
      </p>
    );
  }
  const overview = summarizeTokens(usage);
  const daily = buildDailyUsage(usage);
  const models = groupUsageByModel(usage);
  const months = monthLabels(daily);

  return (
    <ToolWorkbench className="usage-workbench" ariaLabel="用量统计工具页">
      <WorkbenchToolbar ariaLabel="用量统计标题">
        <strong className="tool-workbench__title">用量统计</strong>
        <span className="tool-workbench__meta">
          Token 总量 = 输入 + 输出；缓存单独展示，不重复计入。
        </span>
      </WorkbenchToolbar>
      <section className="usage-summary-strip" aria-label="Token 指标">
        <UsageMetric
          label="总 Token"
          uncached={overview.known_total}
          cached={overview.cache_tokens}
        />
        <UsageMetric
          label="对话 Token"
          uncached={overview.conversation_tokens}
          cached={overview.conversation_cache_tokens}
        />
        <UsageMetric
          label="任务 Token"
          uncached={overview.task_tokens}
          cached={overview.task_cache_tokens}
        />
        {overview.incomplete_entries > 0 ? (
          <p>{overview.incomplete_entries} 条记录的 Token 或缓存数据不完整</p>
        ) : null}
      </section>
      <section
        className="usage-activity"
        aria-labelledby="usage-activity-title"
      >
        <header>
          <h3 id="usage-activity-title">Token 活动</h3>
          <span>最近 365 天 · 每日</span>
        </header>
        <UsageHeatmap daily={daily} months={months} />
      </section>
      <section className="usage-models" aria-labelledby="usage-models-title">
        <header>
          <h3 id="usage-models-title">模型消耗</h3>
          <span>费用只显示可计算的模型小计</span>
        </header>
        <div className="usage-model-table-wrap" data-scroll-key="usage:models">
          <table className="usage-model-table" aria-label="模型消耗">
            <thead>
              <tr>
                <th>Provider / 模型</th>
                <th>未缓存总量</th>
                <th>对话未缓存</th>
                <th>任务未缓存</th>
                <th>缓存</th>
                <th>占比</th>
                <th>已知费用</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.key}>
                  <td>
                    <strong>{model.provider_id}</strong>
                    <span>{model.model_id}</span>
                  </td>
                  <td>
                    {formatTokens(model.total_tokens)}
                    {model.incomplete_token_entries ? " + 不完整" : ""}
                  </td>
                  <td>{formatTokens(model.conversation_tokens)}</td>
                  <td>{formatTokens(model.task_tokens)}</td>
                  <td>{formatTokens(model.cache_tokens)}</td>
                  <td>{(model.share * 100).toFixed(1)}%</td>
                  <td>
                    {formatCost(model.known_cost_usd)}
                    {model.incomplete_cost_entries ? " + 不完整" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </ToolWorkbench>
  );
}
