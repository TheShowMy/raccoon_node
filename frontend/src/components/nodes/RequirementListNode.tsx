import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Item } from "@astryxdesign/core/Item";
import { Stack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Eye, GitBranch, Loader2 } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { formatDate, requirementStatusText } from "../../utils/format";

type RequirementListData = Extract<StartNodeData, { kind: "requirement-list" }>;
type RequirementListItem =
  | RequirementListData["pendingRequirements"][number]
  | RequirementListData["completedRequirements"][number];
type RequirementTab = "pending" | "completed";

function requirementStatusColor(
  status: RequirementListItem["status"],
): "default" | "red" | "green" | "blue" | "purple" | "orange" {
  if (status === "failed") return "red";
  if (status === "completed") return "green";
  if (
    status === "analyzing" ||
    status === "clarifying" ||
    status === "planning"
  ) {
    return "purple";
  }
  if (status === "running") return "orange";
  if (
    status === "draft_ready" ||
    status === "plan_ready" ||
    status === "queued"
  ) {
    return "blue";
  }
  return "default";
}

export default function RequirementListNode({
  data,
}: {
  data: RequirementListData;
}) {
  const [activeTab, setActiveTab] = useState<RequirementTab>("pending");
  const requirements =
    activeTab === "pending"
      ? data.pendingRequirements
      : data.completedRequirements;
  const emptyTitle =
    activeTab === "pending" ? "暂无待执行需求" : "暂无已完成需求";
  const emptyText =
    activeTab === "pending" ? "确认需求后会进入这里" : "完成的需求会显示在这里";

  return (
    <>
      <Stack padding={3} className="nodrag">
        <TabList
          value={activeTab}
          onChange={(value) => {
            if (value === "pending" || value === "completed") {
              setActiveTab(value);
            }
          }}
          layout="fill"
          hasDivider
          aria-label="需求列表"
        >
          <Tab
            value="pending"
            label={`待执行 ${data.pendingRequirements.length}`}
          />
          <Tab
            value="completed"
            label={`已完成 ${data.completedRequirements.length}`}
          />
        </TabList>
      </Stack>
      {requirements.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyText} isCompact />
      ) : (
        <Stack className="nodrag nowheel" padding={3} gap={1} isScrollable>
          {requirements.map((requirement) => {
            const isSelected = data.selectedRequirementId === requirement.id;
            const isBusy = data.busyRequirementId === requirement.id;
            const hasWorkflow = data.workflowRequirementIds.has(requirement.id);
            const canPlan =
              activeTab === "pending" &&
              requirement.status === "failed" &&
              !hasWorkflow;
            const canView = hasWorkflow;
            return (
              <Item
                key={requirement.id}
                label={
                  <Text type="label" maxLines={2} wordBreak="break-word">
                    {requirement.title}
                  </Text>
                }
                description={`更新于 ${formatDate(requirement.updated_at)}`}
                align="start"
                density="compact"
                isSelected={isSelected}
                onClick={() => data.onSelectRequirement(requirement)}
                endContent={
                  <Stack gap={1} align="end">
                    <Token
                      label={requirementStatusText(requirement.status)}
                      color={requirementStatusColor(requirement.status)}
                      size="sm"
                    />
                    {canPlan ? (
                      <Button
                        label={isBusy ? "生成中…" : "重新生成 WorkPlan"}
                        size="sm"
                        variant="ghost"
                        icon={
                          isBusy ? (
                            <Loader2 size={13} className="spin-icon" />
                          ) : (
                            <GitBranch size={13} />
                          )
                        }
                        isDisabled={isBusy}
                        onClick={(event) => {
                          event.stopPropagation();
                          void data.onPlanRequirement(requirement);
                        }}
                      />
                    ) : canView ? (
                      <Token
                        label="查看 WorkflowRun"
                        icon={<Eye size={13} />}
                        color="gray"
                        size="sm"
                      />
                    ) : null}
                  </Stack>
                }
              />
            );
          })}
        </Stack>
      )}
    </>
  );
}
