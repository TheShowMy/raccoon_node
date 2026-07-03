import { ChevronDown, ChevronRight, Gauge } from "lucide-react";
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
              <TokenItem align="left" label="输入" value={usage.input} />
              <TokenItem align="center" label="输出" value={usage.output} />
              <TokenItem
                align="right"
                label="缓存读"
                value={usage.cache_read}
              />
              <TokenItem
                align="left"
                label="缓存写"
                value={usage.cache_write}
              />
              <TokenItem
                align="center"
                label="上下文"
                value={usage.context_tokens}
              />
              <TokenItem
                align="right"
                label="窗口"
                value={usage.context_window}
              />
            </div>
          ) : (
            <div className="token-usage-node__empty">暂无统计</div>
          )}
        </div>
      ) : null}
    </section>
  );
}
