import { Gauge } from "lucide-react";
import type { StartNodeData } from "../../types/api";

type Data = Extract<StartNodeData, { kind: "token-usage" }>;

const number = new Intl.NumberFormat("zh-CN");

export default function TokenUsageNode({ data }: { data: Data }) {
  const usage = data.usage;
  const percent = usage?.context_percent ?? 0;
  const tone = percent >= 80 ? "danger" : percent >= 60 ? "warn" : "ok";

  return (
    <section className={`token-usage-node token-usage-node--${tone}`}>
      <div className="token-usage-node__header">
        <span className="node-icon">
          <Gauge size={18} />
        </span>
        <div>
          <strong>Token 使用</strong>
          <span>{usage ? `${percent.toFixed(1)}% context` : "暂无统计"}</span>
        </div>
      </div>
      <dl>
        <div>
          <dt>input</dt>
          <dd>{number.format(usage?.input ?? 0)}</dd>
        </div>
        <div>
          <dt>output</dt>
          <dd>{number.format(usage?.output ?? 0)}</dd>
        </div>
        <div>
          <dt>cache</dt>
          <dd>
            {number.format(
              (usage?.cache_read ?? 0) + (usage?.cache_write ?? 0),
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
