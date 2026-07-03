import { ChevronDown, ChevronRight, Gauge } from "lucide-react";
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
  const total = usage
    ? usage.input + usage.output + usage.cache_read + usage.cache_write
    : 0;
  const ExpandIcon = data.expanded ? ChevronDown : ChevronRight;

  return (
    <section className="token-usage-node">
      <button
        type="button"
        className="token-usage-node__collapsed nodrag"
        aria-expanded={data.expanded}
        onClick={data.onToggleExpanded}
      >
        <Gauge size={17} />
        <span>
          <strong>Token 使用</strong>
          <small>{usage ? formatCompactNumber(total) : "--"} total</small>
        </span>
        <ExpandIcon size={16} />
      </button>

      {data.expanded ? (
        <div className="token-usage-node__detail nodrag nowheel">
          {usage ? (
            <div className="token-usage-node__grid">
              <TokenItem label="输入" value={usage.input} />
              <TokenItem label="输出" value={usage.output} />
              <TokenItem label="缓存读" value={usage.cache_read} />
              <TokenItem label="缓存写" value={usage.cache_write} />
            </div>
          ) : (
            <div className="token-usage-node__empty">暂无统计</div>
          )}
        </div>
      ) : null}
    </section>
  );
}
