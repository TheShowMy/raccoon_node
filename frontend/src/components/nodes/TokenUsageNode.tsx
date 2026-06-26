import { Gauge } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { formatCompactNumber } from "../../utils/format";

type Data = Extract<StartNodeData, { kind: "token-usage" }>;
type Align = "left" | "center" | "right";

function TokenItem({
  label,
  value,
  align,
}: {
  label: string;
  value: number;
  align: Align;
}) {
  return (
    <div className={`token-usage-node__item token-usage-node__item--${align}`}>
      <span className="token-usage-node__value">
        {formatCompactNumber(value)}
      </span>
      <span className="token-usage-node__label">{label}</span>
    </div>
  );
}

export default function TokenUsageNode({ data }: { data: Data }) {
  const usage = data.usage;

  const totalGroup = (
    <div className="token-usage-node__total-group">
      <span className="token-usage-node__total">
        {usage
          ? formatCompactNumber(
              usage.input + usage.output + usage.cache_read + usage.cache_write,
            )
          : "--"}
      </span>
      <Gauge size={14} className="token-usage-node__icon-inline" />
    </div>
  );

  return (
    <section className="token-usage-node">
      <div className="token-usage-node__header">
        <span className="token-usage-node__title">Token 使用</span>
        {totalGroup}
      </div>
      {usage ? (
        <div className="token-usage-node__grid">
          <TokenItem align="left" label="输入" value={usage.input} />
          <TokenItem align="center" label="输出" value={usage.output} />
          <TokenItem
            align="right"
            label="缓存"
            value={usage.cache_read + usage.cache_write}
          />
        </div>
      ) : (
        <div className="token-usage-node__empty">暂无统计</div>
      )}
    </section>
  );
}
