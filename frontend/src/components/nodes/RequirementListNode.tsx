import React from "react";
import { CheckCircle2, Clock, Eye, GitBranch, Loader2 } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { formatDate, requirementStatusText } from "../../utils/format";

function requirementTaskProgress(
  requirement: Extract<
    StartNodeData,
    { kind: "requirement-list" }
  >["requirements"][number],
) {
  const tasks = requirement.execution_plan?.tasks ?? [];
  if (tasks.length === 0) return null;
  const completed = tasks.filter((task) => task.status === "completed").length;
  return `${completed}/${tasks.length} 个任务`;
}

export default function RequirementListNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-list" }>;
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
        <div className="empty-state">{data.emptyText}</div>
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
              <div
                className={`requirement-list__item ${
                  isSelected ? "requirement-list__item--selected" : ""
                }`}
                key={requirement.id}
                role="button"
                tabIndex={0}
                onClick={() => data.onSelectRequirement(requirement)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    data.onSelectRequirement(requirement);
                  }
                }}
              >
                <div className="requirement-list__item-head">
                  <strong>{requirement.title}</strong>
                  <span
                    className={`requirement-list__status requirement-list__status--${requirement.status}`}
                  >
                    {requirementStatusText(requirement.status)}
                  </span>
                </div>
                {taskProgress ? <em>{taskProgress}</em> : null}
                <small>更新于 {formatDate(requirement.updated_at)}</small>
                {canPlan || canView ? (
                  <span className="requirement-list__actions">
                    {canPlan ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={(event) => {
                          event.stopPropagation();
                          void data.onPlanRequirement(requirement);
                        }}
                      >
                        {isBusy ? (
                          <Loader2 size={13} className="spin-icon" />
                        ) : (
                          <GitBranch size={13} />
                        )}
                        {isBusy ? "生成中" : "重新生成 DAG"}
                      </button>
                    ) : (
                      <span>
                        <Eye size={13} />
                        查看 DAG
                      </span>
                    )}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
