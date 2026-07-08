import { Button } from "@astryxdesign/core/Button";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { CheckCircle2, Clock, Eye, GitBranch, Loader2 } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { formatDate, requirementStatusText } from "../../utils/format";

type RequirementListData = Extract<StartNodeData, { kind: "requirement-list" }>;
type RequirementListItem = RequirementListData["requirements"][number];

function requirementTaskProgress(requirement: RequirementListItem) {
  const tasks = requirement.execution_plan?.tasks ?? [];
  if (tasks.length === 0) return null;
  const completed = tasks.filter((task) => task.status === "completed").length;
  return `${completed}/${tasks.length} 个任务`;
}

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
  const Icon = data.tone === "done" ? CheckCircle2 : Clock;
  return (
    <>
      <div
        className={`node-header ${
          data.tone === "done" ? "node-header--projects" : "node-header--create"
        }`}
      >
        <span className="node-icon">
          <Icon size={20} />
        </span>
        <div>
          <strong>{data.title}</strong>
          <span>{data.description}</span>
        </div>
      </div>
      {data.requirements.length === 0 ? (
        <Stack className="empty-state">
          <Text type="supporting">{data.emptyText}</Text>
        </Stack>
      ) : (
        <div className="requirement-list nowheel nodrag">
          {data.requirements.map((requirement) => {
            const taskProgress = requirementTaskProgress(requirement);
            const isSelected = data.selectedRequirementId === requirement.id;
            const isBusy = data.busyRequirementId === requirement.id;
            const canPlan =
              data.tone === "pending" &&
              requirement.status === "failed" &&
              !requirement.execution_plan;
            const canView = Boolean(requirement.execution_plan);
            return (
              <ClickableCard
                label={requirement.title}
                className={`requirement-list__item ${
                  isSelected ? "requirement-list__item--selected" : ""
                }`}
                key={requirement.id}
                padding={0}
                variant="transparent"
                onClick={() => data.onSelectRequirement(requirement)}
              >
                <Stack
                  className="requirement-list__item-head"
                  direction="horizontal"
                  gap={2}
                  align="start"
                >
                  <Text type="label" maxLines={2} wordBreak="break-word">
                    {requirement.title}
                  </Text>
                  <Token
                    label={requirementStatusText(requirement.status)}
                    color={requirementStatusColor(requirement.status)}
                    size="sm"
                  />
                </Stack>
                {taskProgress ? (
                  <Token label={taskProgress} color="purple" size="sm" />
                ) : null}
                <Text type="supporting" size="3xs">
                  更新于 {formatDate(requirement.updated_at)}
                </Text>
                {canPlan || canView ? (
                  <Stack
                    className="requirement-list__actions"
                    direction="horizontal"
                    gap={2}
                  >
                    {canPlan ? (
                      <Button
                        label={isBusy ? "生成中" : "重新生成 DAG"}
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
                    ) : (
                      <Token
                        label="查看 DAG"
                        icon={<Eye size={13} />}
                        color="gray"
                        size="sm"
                      />
                    )}
                  </Stack>
                ) : null}
              </ClickableCard>
            );
          })}
        </div>
      )}
    </>
  );
}
