import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { StartNodeData } from "../../types/api";
import { formatCompactNumber } from "../../utils/format";

type TokenData = Extract<StartNodeData, { kind: "token-usage" }>;

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Card variant="muted" padding={3}>
      <VStack gap={1}>
        <Text type="supporting" color="secondary">
          {label}
        </Text>
        <Text weight="bold" hasTabularNumbers>
          {formatCompactNumber(value)}
        </Text>
      </VStack>
    </Card>
  );
}

export default function TokenWorkbench({ data }: { data: TokenData }) {
  const usage = data.usage;
  if (!usage) return <EmptyState title="暂无 Token 统计" isCompact />;
  const total =
    usage.input + usage.output + usage.cache_read + usage.cache_write;
  const percent = usage.context_percent;
  return (
    <VStack gap={4} padding={4} isScrollable height="100%">
      <VStack gap={1}>
        <Heading level={2}>上下文占用</Heading>
        <Text type="supporting" color="secondary">
          真实占用 {percent.toFixed(2)}% · 合计 {formatCompactNumber(total)}{" "}
          tokens
        </Text>
      </VStack>
      <ProgressBar
        label="上下文占用"
        value={Math.min(100, Math.max(0, percent))}
        max={100}
        hasValueLabel
        formatValueLabel={() => `${percent.toFixed(2)}%`}
        variant={percent > 90 ? "error" : percent > 70 ? "warning" : "accent"}
      />
      <Grid columns={2} gap={3} width="100%">
        <Metric label="输入" value={usage.input} />
        <Metric label="输出" value={usage.output} />
        <Metric label="缓存读取" value={usage.cache_read} />
        <Metric label="缓存写入" value={usage.cache_write} />
        <Metric label="总计" value={total} />
        <Metric label="上下文窗口" value={usage.context_window} />
      </Grid>
    </VStack>
  );
}
