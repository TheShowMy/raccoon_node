import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Gauge } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { formatCompactNumber } from "../../utils/format";
import NodeBar from "../ui/NodeBar";

type Data = Extract<StartNodeData, { kind: "token-usage" }>;

function TokenItem({ label, value }: { label: string; value: number }) {
  return (
    <Card className="token-usage-node__item" variant="muted" padding={2}>
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
  const total = usage
    ? usage.input + usage.output + usage.cache_read + usage.cache_write
    : 0;

  return (
    <section className="token-usage-node">
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
          className="token-usage-node__detail nodrag nowheel"
          padding={3}
          height="100%"
        >
          {usage ? (
            <Grid columns={2} gap={2} width="100%">
              <TokenItem label="输入" value={usage.input} />
              <TokenItem label="输出" value={usage.output} />
              <TokenItem label="缓存读" value={usage.cache_read} />
              <TokenItem label="缓存写" value={usage.cache_write} />
            </Grid>
          ) : (
            <Stack height="100%" align="center" justify="center">
              <Text type="supporting">暂无统计</Text>
            </Stack>
          )}
        </Stack>
      ) : null}
    </section>
  );
}
