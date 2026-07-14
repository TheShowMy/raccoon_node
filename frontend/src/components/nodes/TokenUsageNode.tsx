import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Gauge } from "lucide-react";
import type { StartNodeData, TokenUsageCategory } from "../../types/api";
import { formatCompactNumber } from "../../utils/format";
import NodeBar from "../ui/NodeBar";

type Data = Extract<StartNodeData, { kind: "token-usage" }>;

function categoryTotal(category: TokenUsageCategory): number {
  return (
    category.input +
    category.output +
    category.cache_read +
    category.cache_write
  );
}

function TokenItem({ label, value }: { label: string; value: number }) {
  return (
    <Card variant="muted" padding={2}>
      <Stack gap={1} align="center">
        <Text
          type="label"
          weight="bold"
          display="block"
          justify="center"
          hasTabularNumbers
        >
          {formatCompactNumber(value)}
        </Text>
        <Text type="supporting" size="3xs" display="block" justify="center">
          {label}
        </Text>
      </Stack>
    </Card>
  );
}

export default function TokenUsageNode({ data }: { data: Data }) {
  const usage = data.usage;
  const total = usage ? categoryTotal(usage.total) : 0;

  return (
    <Stack width="100%" height="100%">
      <NodeBar
        icon={<Gauge size={16} />}
        accent="var(--color-success)"
        title="Token 使用"
        subtitle={`${usage ? formatCompactNumber(total) : "--"} total`}
        expanded={data.expanded}
        onToggle={data.onToggleExpanded}
      />

      {data.expanded ? (
        <Stack
          className="nodrag nowheel"
          padding={3}
          height="100%"
          style={{ overflow: "auto" }}
        >
          {usage ? (
            <Stack gap={3}>
              <Grid columns={3} gap={2} width="100%">
                <TokenItem label="对话" value={categoryTotal(usage.chat)} />
                <TokenItem
                  label="拆分任务"
                  value={categoryTotal(usage.split)}
                />
                <TokenItem label="任务" value={categoryTotal(usage.task)} />
              </Grid>
              <Text type="supporting" size="3xs">
                最大上下文占比 {(usage.max_context_percent ?? 0).toFixed(1)}%
              </Text>
              {(usage.hotspots ?? []).slice(0, 3).map((item) => (
                <Text
                  key={`${item.role}:${item.label}`}
                  type="supporting"
                  size="3xs"
                >
                  {item.label} · {item.role} ·{" "}
                  {formatCompactNumber(categoryTotal(item.usage))}
                  {item.budget_exceeded ? " · 已超观测预算" : ""}
                </Text>
              ))}
              {(usage.sources ?? []).slice(0, 3).map((item) => (
                <Text
                  key={`${item.kind}:${item.label}`}
                  type="supporting"
                  size="3xs"
                >
                  估算来源 {item.label} ·{" "}
                  {formatCompactNumber(item.estimated_tokens)} tokens
                </Text>
              ))}
            </Stack>
          ) : (
            <Stack height="100%" align="center" justify="center">
              <Text type="supporting">暂无统计</Text>
            </Stack>
          )}
        </Stack>
      ) : null}
    </Stack>
  );
}
