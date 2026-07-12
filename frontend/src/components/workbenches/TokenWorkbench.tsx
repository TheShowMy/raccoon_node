import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { GitBranch, Hammer, MessageCircle } from "lucide-react";
import type { StartNodeData, TokenUsageCategory } from "../../types/api";
import { formatCompactNumber } from "../../utils/format";

type TokenData = Extract<StartNodeData, { kind: "token-usage" }>;

function categoryTotal(category: TokenUsageCategory): number {
  return (
    category.input +
    category.output +
    category.cache_read +
    category.cache_write
  );
}

function totalTokens(usage: NonNullable<TokenData["usage"]>): number {
  return categoryTotal(usage.total);
}

const CATEGORIES: {
  key: "chat" | "split" | "task";
  label: string;
  icon: React.ReactNode;
  color: string;
}[] = [
  {
    key: "chat",
    label: "对话消耗",
    icon: <MessageCircle size={18} />,
    color: "var(--token-chat)",
  },
  {
    key: "split",
    label: "拆分任务消耗",
    icon: <GitBranch size={18} />,
    color: "var(--token-split)",
  },
  {
    key: "task",
    label: "任务消耗",
    icon: <Hammer size={18} />,
    color: "var(--token-task)",
  },
];

function CategoryCard({
  label,
  icon,
  color,
  category,
}: {
  label: string;
  icon: React.ReactNode;
  color: string;
  category: TokenUsageCategory;
}) {
  return (
    <Card variant="muted" padding={3}>
      <VStack gap={2}>
        <HStack gap={2} align="center">
          <span style={{ color, display: "flex" }}>{icon}</span>
          <Text type="supporting" color="secondary">
            {label}
          </Text>
        </HStack>
        <Text weight="bold" size="sm" hasTabularNumbers>
          {formatCompactNumber(categoryTotal(category))}
        </Text>
        <Text type="supporting" size="xsm" color="secondary" hasTabularNumbers>
          输入 {formatCompactNumber(category.input)} · 输出{" "}
          {formatCompactNumber(category.output)} · 缓存读{" "}
          {formatCompactNumber(category.cache_read)} · 缓存写{" "}
          {formatCompactNumber(category.cache_write)}
        </Text>
      </VStack>
    </Card>
  );
}

export default function TokenWorkbench({ data }: { data: TokenData }) {
  const usage = data.usage;
  if (!usage) return <EmptyState title="暂无 Token 统计" isCompact />;

  const total = totalTokens(usage);
  const chatTotal = categoryTotal(usage.chat);
  const splitTotal = categoryTotal(usage.split);
  const taskTotal = categoryTotal(usage.task);

  return (
    <VStack gap={5} padding={4} isScrollable height="100%">
      <Card padding={4}>
        <VStack gap={2} align="center">
          <Text type="supporting" color="secondary">
            总消耗 Tokens
          </Text>
          <Text weight="bold" size="sm" hasTabularNumbers>
            {formatCompactNumber(total)}
          </Text>
          <Text type="supporting" size="sm" color="secondary" hasTabularNumbers>
            输入 {formatCompactNumber(usage.total.input)} · 输出{" "}
            {formatCompactNumber(usage.total.output)} · 缓存读{" "}
            {formatCompactNumber(usage.total.cache_read)} · 缓存写{" "}
            {formatCompactNumber(usage.total.cache_write)}
          </Text>
        </VStack>
      </Card>

      <Grid columns={3} gap={3} width="100%">
        {CATEGORIES.map((category) => (
          <CategoryCard
            key={category.key}
            label={category.label}
            icon={category.icon}
            color={category.color}
            category={usage[category.key]}
          />
        ))}
      </Grid>

      <VStack gap={2} width="100%">
        <Text type="supporting" size="sm" color="secondary">
          消耗分布
        </Text>
        <div className="token-usage-bar">
          {total > 0 && (
            <>
              <div
                className="token-usage-segment token-usage-chat"
                style={{ width: `${(chatTotal / total) * 100}%` }}
              />
              <div
                className="token-usage-segment token-usage-split"
                style={{ width: `${(splitTotal / total) * 100}%` }}
              />
              <div
                className="token-usage-segment token-usage-task"
                style={{ width: `${(taskTotal / total) * 100}%` }}
              />
            </>
          )}
        </div>
        <HStack gap={3} justify="center" wrap="wrap">
          {CATEGORIES.map((category) => (
            <HStack key={category.key} gap={1} align="center">
              <span
                className={`token-usage-dot token-usage-${category.key}`}
                style={{ backgroundColor: category.color }}
              />
              <Text type="supporting" size="xsm" color="secondary">
                {category.label}
              </Text>
            </HStack>
          ))}
        </HStack>
      </VStack>
    </VStack>
  );
}
