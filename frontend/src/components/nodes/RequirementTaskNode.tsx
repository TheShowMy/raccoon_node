import React from "react";
import { CircleDot, RotateCcw } from "lucide-react";
import type { RequirementExecutionTask, StartNodeData } from "../../types/api";

const taskStatusText: Record<RequirementExecutionTask["status"], string> = {
  pending: "待执行",
  running: "执行中",
  awaiting_review: "待审核",
  fixing: "修复中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  approved: "已通过",
  rejected: "未通过",
};

const taskKindText: Record<RequirementExecutionTask["kind"], string> = {
  implementation: "实现",
  review: "审核",
  merge_review: "合并审核",
};

export default function RequirementTaskNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-task" }>;
}) {
  const task = data.task;
  const canRetryFailed = task.status === "failed";
  const isMergeReview = task.kind === "merge_review";
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
        <small>
          {taskKindText[task.kind]} · {task.model_tier} ·{" "}
          {Math.round(task.timeout_seconds / 60)} 分钟
        </small>
        {!isMergeReview ? (
          <div className="task-node__mini-flow">
            <div className="task-node__mini-card task-node__mini-card--code">
              <strong>代码</strong>
              <span>{taskStatusText[task.status]}</span>
              {task.commit_sha ? (
                <small>{task.commit_sha.slice(0, 8)}</small>
              ) : null}
            </div>
            <div className="task-node__mini-arrow" />
            <div className="task-node__review-stack">
              {data.reviews.length > 0 ? (
                data.reviews.map((review) => (
                  <div
                    className="task-node__mini-card task-node__mini-card--review"
                    key={review.id}
                  >
                    <strong>{review.review_angle ?? "综合审核"}</strong>
                    <span>{taskStatusText[review.status]}</span>
                    {review.last_review_feedback ? (
                      <small>{review.last_review_feedback}</small>
                    ) : null}
                    <button
                      className="task-node__mini-action nowheel nodrag"
                      type="button"
                      disabled={data.busy}
                      onClick={() =>
                        void data.onRerunReview(data.requirementId, review.id)
                      }
                    >
                      <RotateCcw size={12} />
                      重跑
                    </button>
                  </div>
                ))
              ) : (
                <div className="task-node__mini-card task-node__mini-card--review">
                  <strong>综合审核</strong>
                  <span>待生成</span>
                </div>
              )}
            </div>
          </div>
        ) : null}
        {task.branch_name ? <small>分支：{task.branch_name}</small> : null}
        {task.commit_sha ? (
          <small>提交：{task.commit_sha.slice(0, 8)}</small>
        ) : null}
        {task.target_files.length > 0 ? (
          <small>范围：{task.target_files.join("、")}</small>
        ) : null}
        {task.result_summary ? (
          <small>结果：{task.result_summary}</small>
        ) : null}
        {task.error ? (
          <small className="task-node__error">{task.error}</small>
        ) : null}
        {task.last_review_feedback ? (
          <small className="task-node__error">
            审核意见：{task.last_review_feedback}
          </small>
        ) : null}
        <div className="task-node__actions nowheel nodrag">
          {canRetryFailed ? (
            <button
              type="button"
              disabled={data.busy}
              onClick={() =>
                void data.onRetryFailedNode(data.requirementId, task.id)
              }
            >
              <RotateCcw size={13} />
              重试
            </button>
          ) : null}
          <button
            type="button"
            disabled={data.busy}
            onClick={() =>
              void data.onRetryFromNode(data.requirementId, task.id)
            }
          >
            <RotateCcw size={13} />
            从此恢复
          </button>
        </div>
      </div>
    </>
  );
}
