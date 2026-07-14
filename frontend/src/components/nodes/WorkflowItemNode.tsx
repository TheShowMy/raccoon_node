import { HStack } from "@astryxdesign/core/HStack";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { ListChecks } from "lucide-react";
import type { StartNodeData, WorkItemStatus } from "../../types/api";

const statusText: Record<WorkItemStatus, string> = {
  pending: "待执行",
  running: "执行中",
  accepted: "已交付",
  blocked: "待修复",
  cancelled: "已取消",
};

function statusVariant(status: WorkItemStatus) {
  if (status === "accepted") return "success" as const;
  if (status === "blocked" || status === "cancelled") return "error" as const;
  return "neutral" as const;
}

export default function WorkflowItemNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "workflow-item" }>;
}) {
  const { workflow, item } = data;
  const attempts = workflow.attempts.filter(
    (attempt) => attempt.work_item_id === item.id,
  );
  const latestAttempt = attempts.at(-1);
  const parallelGroup = item.group
    ? workflow.work_items
        .filter((candidate) => candidate.group === item.group)
        .sort((left, right) => left.position - right.position)
    : [];
  const parallelIndex = parallelGroup.findIndex(
    (candidate) => candidate.id === item.id,
  );

  return (
    <>
      <Toolbar
        label={item.objective}
        size="sm"
        variant="muted"
        startContent={
          <HStack align="center" gap={2}>
            <ListChecks size={16} aria-hidden />
            <Stack gap={0.5}>
              <Text type="label" size="2xs" maxLines={1}>
                行为切片 {item.position + 1}
              </Text>
              <Text type="supporting" size="3xs" maxLines={1}>
                {parallelGroup.length > 1
                  ? `并行组 ${item.group} · ${parallelIndex + 1}/${parallelGroup.length}`
                  : "串行"}
              </Text>
            </Stack>
          </HStack>
        }
        endContent={
          <HStack gap={1} align="center">
            <StatusDot
              variant={statusVariant(item.status)}
              label={statusText[item.status]}
              isPulsing={item.status === "running"}
            />
            <Token
              label={statusText[item.status]}
              color={
                item.status === "accepted"
                  ? "green"
                  : item.status === "blocked"
                    ? "red"
                    : "gray"
              }
              size="sm"
            />
          </HStack>
        }
      />

      <Stack padding={3} gap={2}>
        <Text type="supporting" size="2xs" maxLines={3}>
          {item.objective}
        </Text>

        <HStack gap={1} wrap="wrap">
          <Token label={`尝试 ${attempts.length}`} color="gray" size="sm" />
          <Token
            label={`场景 ${item.scenario_refs.length}`}
            color="gray"
            size="sm"
          />
          <Token
            label={`验证目标 ${item.verification_goals.length}`}
            color="gray"
            size="sm"
          />
        </HStack>

        {latestAttempt?.failure_message ? (
          <Text type="supporting" size="3xs" color="accent" maxLines={2}>
            {latestAttempt.failure_message}
          </Text>
        ) : latestAttempt?.result_summary ? (
          <Text type="supporting" size="3xs" maxLines={2}>
            {latestAttempt.result_summary}
          </Text>
        ) : null}
      </Stack>
    </>
  );
}
