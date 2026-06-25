import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  Eye,
  GitMerge,
  Loader2,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  RequirementExecutionTask,
  RequirementRecoveryStage,
  StartNodeData,
  TraceUsage,
} from "../../types/api";
import { useRequirementTaskEvents } from "../../contexts/RequirementTaskEventsContext";
import TraceBubble from "../ui/TraceBubble";
import {
  buildBubbleStreamFromEvents,
  buildBubbleStreamFromTrace,
  tierLabels,
  traceFromMetadata,
} from "../../utils/format";

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
  review_summary: "审核汇总",
  review_sub_agent: "审核 Sub Agent",
  branch_merge: "分支合并",
  merge_review: "合并审核",
};

export default function RequirementTaskNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-task" }>;
}) {
  const task = data.task;
  const canRecover = isRecoverable(task.status);
  const nodeRole = data.nodeRole ?? "external";
  const statusClass = `task-node--status-${task.status}`;
  const [detailOpen, setDetailOpen] = useState(false);
  if (nodeRole === "group") {
    const CollapseIcon = data.collapsed ? ChevronRight : ChevronDown;
    return (
      <div
        className={`task-node task-node--group ${statusClass} ${
          data.collapsed ? "task-node--collapsed" : ""
        }`}
      >
        <div className="task-node__head">
          <span className="node-icon">
            {task.status === "running" ? (
              <Loader2 size={18} className="spin-icon" />
            ) : (
              <CircleDot size={18} />
            )}
          </span>
          <div>
            <strong>{task.title}</strong>
            <div className="task-node__status-list">
              <span
                className={`task-node__status task-node__status--${task.status}`}
              >
                {taskStatusText[task.status]}
              </span>
              {task.recovery_stage !== "none" ? (
                <span className="task-node__recovery-status">
                  {recoveryStageText(task)}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="task-node__collapse nowheel nodrag"
            onClick={() =>
              data.onToggleCollapsed?.(data.requirementId, task.id)
            }
            aria-label={data.collapsed ? "展开任务组" : "折叠任务组"}
            aria-expanded={!data.collapsed}
          >
            <CollapseIcon size={15} />
          </button>
        </div>
      </div>
    );
  }
  const Icon =
    nodeRole === "code"
      ? Code2
      : nodeRole === "review_summary" || nodeRole === "review_sub_agent"
        ? ShieldCheck
        : task.kind === "branch_merge"
          ? GitMerge
          : CircleDot;
  return (
    <>
      <div className={`task-node task-node--${nodeRole} ${statusClass}`}>
        <div className="task-node__head">
          <span className="node-icon">
            {task.status === "running" ? (
              <Loader2 size={18} className="spin-icon" />
            ) : (
              <Icon size={18} />
            )}
          </span>
          <div>
            <strong>
              {nodeRole === "code"
                ? "代码节点"
                : task.review_angle || taskKindText[task.kind]}
            </strong>
            <span
              className={`task-node__status task-node__status--${task.status}`}
            >
              {taskStatusText[task.status]}
            </span>
          </div>
        </div>
        <div className="task-node__body">
          <p className="task-node__summary">
            {task.result_summary ?? task.description}
          </p>
          {task.execution_warning ? (
            <small className="task-node__warning">
              {task.execution_warning}
            </small>
          ) : null}
          {task.commit_sha ? (
            <small>{task.commit_sha.slice(0, 8)}</small>
          ) : null}
          <div className="task-node__actions nowheel nodrag">
            <button type="button" onClick={() => setDetailOpen(true)}>
              <Eye size={13} />
              详情
            </button>
            {task.status === "failed" ? (
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
            {(nodeRole === "review_summary" ||
              nodeRole === "review_sub_agent") &&
            isRecoverable(task.status) ? (
              <button
                type="button"
                disabled={data.busy}
                onClick={() =>
                  void data.onRerunReview(data.requirementId, task.id)
                }
              >
                <RotateCcw size={13} />
                重跑
              </button>
            ) : null}
            {canRecover ? (
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
            ) : null}
          </div>
        </div>
      </div>
      <TaskDetailDialog
        open={detailOpen}
        task={task}
        reviews={data.reviews}
        onClose={() => setDetailOpen(false)}
      />
    </>
  );
}

function TaskDetailDialog({
  open,
  task,
  reviews,
  onClose,
}: {
  open: boolean;
  task: RequirementExecutionTask;
  reviews: RequirementExecutionTask[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const historicalTrace = traceFromMetadata(task.trace);
  const reviewFeedback = buildReviewFeedback(task, reviews);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [open]);

  if (!open) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="task-detail-dialog"
      onClose={onClose}
      onClick={onClose}
    >
      <div
        className="node-card node-card--requirement-task task-detail-dialog__panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="task-detail-dialog__head">
          <span className="node-icon task-detail-dialog__icon">
            <CircleDot size={22} />
          </span>
          <div>
            <strong>{task.title}</strong>
            <span>{taskKindText[task.kind]}详情</span>
          </div>
          <span
            className={`task-node__status task-node__status--${task.status} task-detail-dialog__status`}
          >
            {taskStatusText[task.status]}
          </span>
          <button type="button" onClick={onClose} aria-label="关闭详情">
            <X size={16} />
          </button>
        </div>
        <div className="task-detail-dialog__body">
          <section className="task-detail-dialog__section task-detail-dialog__section--wide">
            <h3>任务描述</h3>
            <p className="task-detail-dialog__text">{task.description}</p>
          </section>
          <section className="task-detail-dialog__section task-detail-dialog__section--wide">
            <h3>节点交互</h3>
            <ol className="task-detail-dialog__flow">
              <li>
                <strong>代码节点</strong>
                <span
                  className={`task-node__status task-node__status--${task.status}`}
                >
                  {taskStatusText[task.status]}
                </span>
              </li>
              {reviews.map((review) => (
                <li key={review.id}>
                  <strong>{review.review_angle ?? "综合审核"}</strong>
                  <span
                    className={`task-node__status task-node__status--${review.status}`}
                  >
                    {taskStatusText[review.status]}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <TaskExecutionTrace task={task} />
          {historicalTrace?.usage ? (
            <TaskUsage usage={historicalTrace.usage} />
          ) : null}
          <section className="task-detail-dialog__section task-detail-dialog__section--wide">
            <h3>恢复信息</h3>
            <dl className="task-detail-dialog__info-list task-detail-dialog__info-list--embedded">
              <DetailItem label="失败原因" value={task.error} danger />
              <DetailItem label="失败摘要" value={task.failure_summary} />
              <DetailItem
                label="执行失败次数"
                value={String(task.execution_failure_count)}
              />
              <DetailItem
                label="审核拒绝次数"
                value={String(task.review_rejection_count)}
              />
              <DetailItem
                label="恢复方案"
                value={task.recovery_guidance}
                warning
              />
              <DetailItem
                label="当前有效档位"
                value={effectiveTierText(task)}
              />
            </dl>
          </section>
          <details className="task-detail-dialog__details">
            <summary>基础信息</summary>
            <dl className="task-detail-dialog__info-list">
              <DetailItem label="结果" value={task.result_summary} />
              <DetailItem
                label="执行提示"
                value={task.execution_warning}
                warning
              />
              <DetailItem label="分支" value={task.branch_name} />
              <DetailItem label="Worktree" value={task.worktree_path} mono />
              <DetailItem label="提交" value={task.commit_sha} mono />
              <DetailItem
                label="目标文件"
                value={task.target_files.join("、")}
              />
              <DetailItem
                label="PR"
                value={task.pull_request_url}
                href={task.pull_request_url}
              />
              <DetailItem label="合入分支" value={task.merged_into} />
              <DetailItem label="清理结果" value={task.cleanup_summary} />
              <DetailItem label="审核意见" value={reviewFeedback} danger />
            </dl>
          </details>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

function TaskExecutionTrace({ task }: { task: RequirementExecutionTask }) {
  const taskEvents = useRequirementTaskEvents(task.id);
  const liveBubbles = buildBubbleStreamFromEvents(taskEvents);
  const historicalTrace = traceFromMetadata(task.trace);
  const traceBubbles =
    liveBubbles.length > 0
      ? liveBubbles
      : historicalTrace
        ? buildBubbleStreamFromTrace(historicalTrace)
        : [];

  return (
    <section className="task-detail-dialog__section task-detail-dialog__section--wide">
      <h3>执行过程</h3>
      {traceBubbles.length > 0 ? (
        <TraceBubble bubbles={traceBubbles} isLive={liveBubbles.length > 0} />
      ) : (
        <p className="task-detail-dialog__empty">暂无执行过程</p>
      )}
    </section>
  );
}

function TaskUsage({ usage }: { usage: TraceUsage }) {
  const number = new Intl.NumberFormat("zh-CN");
  const cacheTotal = usage.input + usage.cacheRead;
  const cacheHitRate =
    cacheTotal > 0
      ? `${((usage.cacheRead / cacheTotal) * 100).toFixed(1)}%`
      : "0.0%";

  return (
    <section className="task-detail-dialog__section task-detail-dialog__section--wide">
      <h3>会话统计</h3>
      <dl className="task-detail-dialog__usage">
        <div>
          <dt>会话是否复用</dt>
          <dd>{usage.sessionReused ? "是" : "否"}</dd>
        </div>
        <div>
          <dt>累计调用数</dt>
          <dd>{number.format(usage.callCount)} 次</dd>
        </div>
        <div>
          <dt>input</dt>
          <dd>{number.format(usage.input)}</dd>
        </div>
        <div>
          <dt>output</dt>
          <dd>{number.format(usage.output)}</dd>
        </div>
        <div>
          <dt>cacheRead</dt>
          <dd>{number.format(usage.cacheRead)}</dd>
        </div>
        <div>
          <dt>cacheWrite</dt>
          <dd>{number.format(usage.cacheWrite)}</dd>
        </div>
        <div>
          <dt>缓存命中率</dt>
          <dd>{cacheHitRate}</dd>
        </div>
        <div>
          <dt>context tokens</dt>
          <dd>{number.format(usage.context.tokens)}</dd>
        </div>
        <div>
          <dt>context window</dt>
          <dd>{number.format(usage.context.window)}</dd>
        </div>
        <div>
          <dt>context percent</dt>
          <dd>{usage.context.percent.toFixed(1)}%</dd>
        </div>
      </dl>
    </section>
  );
}

function buildReviewFeedback(
  task: RequirementExecutionTask,
  reviews: RequirementExecutionTask[],
) {
  const feedback = [];
  if (task.last_review_feedback) {
    feedback.push(task.last_review_feedback);
  }
  for (const review of reviews) {
    if (review.last_review_feedback) {
      feedback.push(
        `${review.review_angle ?? review.title}：${review.last_review_feedback}`,
      );
    }
  }
  return feedback.join("\n");
}

function DetailItem({
  label,
  value,
  href,
  mono,
  danger,
  warning,
}: {
  label: string;
  value: string | null;
  href?: string | null;
  mono?: boolean;
  danger?: boolean;
  warning?: boolean;
}) {
  if (!value) return null;
  return (
    <>
      <dt>{label}</dt>
      {href ? (
        <dd>
          <a href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        </dd>
      ) : (
        <dd
          className={`${mono ? "is-mono" : ""} ${danger ? "is-danger" : ""} ${
            warning ? "is-warning" : ""
          }`}
        >
          {value}
        </dd>
      )}
    </>
  );
}

function isRecoverable(status: RequirementExecutionTask["status"]) {
  return status === "failed" || status === "rejected";
}

function recoveryStageText(task: RequirementExecutionTask) {
  const labels: Record<RequirementRecoveryStage, string> = {
    none: "",
    auto_retry: `自动重试 ${Math.min(task.execution_failure_count, 2)}/2`,
    guided_retry: task.recovery_guidance ? "按恢复方案重试" : "高档指导中",
    high_tier_execution: "高档模型接管",
    exhausted: "重试已停止",
  };
  return labels[task.recovery_stage];
}

function effectiveTierText(task: RequirementExecutionTask) {
  const tier = task.high_tier_execution_used ? "high" : task.model_tier;
  return `${tierLabels[tier]}档${task.high_tier_execution_used ? "（恢复升级）" : ""}`;
}
