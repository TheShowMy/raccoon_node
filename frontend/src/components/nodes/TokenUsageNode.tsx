import { Gauge } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { formatCompactNumber } from "../../utils/format";

type Data = Extract<StartNodeData, { kind: "token-usage" }>;

function TokenItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="token-usage-node__item">
      <span className="token-usage-node__value">
        {formatCompactNumber(value)}
      </span>
      <span className="token-usage-node__label">{label}</span>
    </div>
  );
}

export default function TokenUsageNode({ data }: { data: Data }) {
  const usage = data.usage;

  if (!usage) {
    return (
      <section className="token-usage-node">
        <Gauge size={14} className="token-usage-node__icon" />
        <div className="token-usage-node__empty">暂无统计</div>
      </section>
    );
  }

  const input = usage.input;
  const output = usage.output;
  const cacheRead = usage.cache_read;
  const cacheWrite = usage.cache_write;
  const total = input + output + cacheRead + cacheWrite;

  return (
    <section className="token-usage-node">
      <Gauge size={14} className="token-usage-node__icon" />
      <div className="token-usage-node__header">
        <span className="token-usage-node__title">Token 使用</span>
        <span className="token-usage-node__total">
          {formatCompactNumber(total)}
        </span>
      </div>
      <div className="token-usage-node__grid">
        <TokenItem label="输入" value={input} />
        <TokenItem label="输出" value={output} />
        <TokenItem label="缓存" value={cacheRead + cacheWrite} />
      </div>
    </section>
  );
}
