import React from "react";
import { CircleDot } from "lucide-react";
import type { RequirementExecutionTask, StartNodeData } from "../../types/api";

const taskStatusText: Record<RequirementExecutionTask["status"], string> = {
  pending: "待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

export default function RequirementTaskNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-task" }>;
}) {
  const task = data.task;
  return (
    <>
      <div className="task-node__head">
        <span className="node-icon">
          <CircleDot size={18} />
        </span>
        <div>
          <strong>{task.title}</strong>
          <span
            className={`task-node__status task-node__status--${task.status}`}
          >
            {taskStatusText[task.status]}
          </span>
        </div>
      </div>
      <div className="task-node__body">
        <p>{task.description}</p>
        {task.target_files.length > 0 ? (
          <small>范围：{task.target_files.join("、")}</small>
        ) : null}
        {task.result_summary ? (
          <small>结果：{task.result_summary}</small>
        ) : null}
        {task.error ? (
          <small className="task-node__error">{task.error}</small>
        ) : null}
      </div>
    </>
  );
}
