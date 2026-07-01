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
  RequirementReviewStatus,
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
  const nodeRole = data.nodeRole ?? "external";
  const groupFailed =
    nodeRole === "group" &&
    (task.status === "failed" ||
      data.reviews.some((review) => review.status === "failed"));
  const displayedStatus = groupFailed ? "failed" : task.status;
  const statusClass = `task-node--status-${displayedStatus}`;
  const [detailOpen, setDetailOpen] = useState(false);
  if (nodeRole === "group") {
    const CollapseIcon = data.collapsed ? ChevronRight : ChevronDown;
    return (
      <>
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
                  className={`task-node__status task-node__status--${displayedStatus}`}
                >
                  {taskStatusText[displayedStatus]}
                </span>
                {task.recovery_stage !== "none" ? (
                  <span className="task-node__recovery-status">
                    {recoveryStageText(task)}
                  </span>
                ) : null}
              </div>
            </div>
            {groupFailed ? (
              <button
                type="button"
                className="task-node__recover nowheel nodrag"
                disabled={data.busy}
                onClick={() =>
                  void data.onRecoverTaskGroup(data.requirementId, task.id)
                }
              >
                <RotateCcw size={13} />
                恢复
              </button>
            ) : null}
            <button
              type="button"
              className="task-node__detail nowheel nodrag"
              onClick={() => setDetailOpen(true)}
            >
              <Eye size={13} />
              详情
            </button>
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
        <TaskDetailDialog
          open={detailOpen}
          task={task}
          reviews={data.reviews}
          dependencies={data.dependencies}
          onClose={() => setDetailOpen(false)}
        />
      </>
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
            {nodeRole === "external" && task.status === "failed" ? (
              <button
                type="button"
                className="task-node__recover nowheel nodrag"
                disabled={data.busy}
                onClick={() =>
                  void data.onRecoverTaskGroup(data.requirementId, task.id)
                }
              >
                <RotateCcw size={13} />
                恢复
              </button>
            ) : null}
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
          {nodeRole === "external" ? (
            <div className="task-node__actions nowheel nodrag">
              <button type="button" onClick={() => setDetailOpen(true)}>
                <Eye size={13} />
                详情
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {nodeRole === "external" ? (
        <TaskDetailDialog
          open={detailOpen}
          task={task}
          reviews={data.reviews}
          dependencies={data.dependencies}
          onClose={() => setDetailOpen(false)}
        />
      ) : null}
    </>
  );
}

function TaskDetailDialog({
  open,
  task,
  reviews,
  dependencies,
  onClose,
}: {
  open: boolean;
  task: RequirementExecutionTask;
  reviews: RequirementExecutionTask[];
  dependencies: RequirementExecutionTask[];
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
          <TaskDetailFlow
            task={task}
            reviews={reviews}
            dependencies={dependencies}
          />
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

function TaskDetailFlow({
  task,
  reviews,
  dependencies,
}: {
  task: RequirementExecutionTask;
  reviews: RequirementExecutionTask[];
  dependencies: RequirementExecutionTask[];
}) {
  if (task.kind === "branch_merge") {
    return <BranchMergeFlow task={task} dependencies={dependencies} />;
  }
  if (task.kind === "merge_review") {
    return <MergeReviewFlow task={task} dependencies={dependencies} />;
  }
  return <ImplementationReviewFlow task={task} reviews={reviews} />;
}

function ImplementationReviewFlow({
  task,
  reviews,
}: {
  task: RequirementExecutionTask;
  reviews: RequirementExecutionTask[];
}) {
  return (
    <section className="task-detail-dialog__section task-detail-dialog__section--wide">
      <h3>实现与审核</h3>
      {task.review_history.length > 0 ? (
        <div className="task-detail-dialog__rounds">
          {task.review_history.map((round) => (
            <article
              className="task-detail-dialog__round"
              key={`${round.round}-${round.implementation_attempt}`}
            >
              <header>
                <strong>第 {round.round} 轮</strong>
                <span className={`is-${round.status}`}>
                  {reviewRoundStatusText[round.status]}
                </span>
              </header>
              <div className="task-detail-dialog__lanes">
                <div className="task-detail-dialog__lane">
                  <b>实现 Agent</b>
                  <FlowStep
                    title={
                      round.implementation_attempt > 1
                        ? `第 ${round.implementation_attempt} 次修复`
                        : "完成实现"
                    }
                    detail={round.implementation_summary ?? "等待实现结果"}
                    status={
                      round.implementation_summary ? "approved" : "pending"
                    }
                  />
                </div>
                <ReviewExchange rejected={round.status === "rejected"} />
                <div className="task-detail-dialog__lane">
                  <b>审核 Agent 组</b>
                  {round.reviews.length > 0 ? (
                    round.reviews.map((review) => (
                      <FlowStep
                        key={review.task_id}
                        title={review.angle || "综合审核"}
                        detail={
                          review.failure_reason ?? review.summary ?? "等待审核"
                        }
                        status={review.status}
                      />
                    ))
                  ) : (
                    <FlowStep
                      title="等待审核"
                      detail="审核 Agent 尚未返回结果"
                      status="pending"
                    />
                  )}
                  {round.summary || round.failure_reason ? (
                    <FlowStep
                      title="审核汇总"
                      detail={
                        round.failure_reason ?? round.summary ?? "等待审核汇总"
                      }
                      status={round.summary_conclusion ?? "pending"}
                    />
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <CurrentReviewFlow task={task} reviews={reviews} />
      )}
    </section>
  );
}

function CurrentReviewFlow({
  task,
  reviews,
}: {
  task: RequirementExecutionTask;
  reviews: RequirementExecutionTask[];
}) {
  return (
    <div className="task-detail-dialog__lanes">
      <div className="task-detail-dialog__lane">
        <b>实现 Agent</b>
        <FlowStep
          title="当前实现"
          detail={task.result_summary ?? task.description}
          status={toReviewStatus(task.status)}
        />
      </div>
      <ReviewExchange
        rejected={task.status === "fixing" || task.status === "rejected"}
      />
      <div className="task-detail-dialog__lane">
        <b>审核 Agent 组</b>
        {reviews.length > 0 ? (
          reviews.map((review) => (
            <FlowStep
              key={review.id}
              title={review.review_angle ?? taskKindText[review.kind]}
              detail={
                review.last_review_feedback ??
                review.result_summary ??
                "等待审核"
              }
              status={toReviewStatus(review.status)}
            />
          ))
        ) : (
          <FlowStep title="等待审核" detail="尚无审核记录" status="pending" />
        )}
      </div>
    </div>
  );
}

function BranchMergeFlow({
  task,
  dependencies,
}: {
  task: RequirementExecutionTask;
  dependencies: RequirementExecutionTask[];
}) {
  const dependencyStatus: RequirementReviewStatus = dependencies.some(
    (dependency) => ["failed", "rejected"].includes(dependency.status),
  )
    ? "rejected"
    : dependencies.length > 0 &&
        dependencies.every((dependency) =>
          ["completed", "approved"].includes(dependency.status),
        )
      ? "approved"
      : "pending";
  return (
    <section className="task-detail-dialog__section task-detail-dialog__section--wide">
      <h3>分支合并</h3>
      <div className="task-detail-dialog__pipeline">
        <FlowStage title="依赖分支" status={dependencyStatus}>
          {dependencies.length > 0
            ? dependencies.map((dependency) => (
                <span key={dependency.id}>
                  {dependency.title}
                  {dependency.branch_name ? ` · ${dependency.branch_name}` : ""}
                </span>
              ))
            : "等待依赖任务"}
        </FlowStage>
        <span aria-hidden="true">→</span>
        <FlowStage title="合并" status={toReviewStatus(task.status)}>
          {task.title}
        </FlowStage>
        <span aria-hidden="true">→</span>
        <FlowStage title="合并结果" status={toReviewStatus(task.status)}>
          {task.error ?? task.result_summary ?? "等待合并"}
        </FlowStage>
      </div>
    </section>
  );
}

function MergeReviewFlow({
  task,
  dependencies,
}: {
  task: RequirementExecutionTask;
  dependencies: RequirementExecutionTask[];
}) {
  const dependencyStatus: RequirementReviewStatus = dependencies.some(
    (dependency) => ["failed", "rejected"].includes(dependency.status),
  )
    ? "rejected"
    : dependencies.length > 0 &&
        dependencies.every((dependency) =>
          ["completed", "approved"].includes(dependency.status),
        )
      ? "approved"
      : "pending";
  const reviewStatus =
    task.review_status === "pending"
      ? toReviewStatus(task.status)
      : task.review_status;
  const stages: Array<{
    title: string;
    detail: string;
    status: RequirementReviewStatus;
  }> = [
    {
      title: "依赖汇入",
      detail:
        dependencies.length > 0
          ? dependencies.map((dependency) => dependency.title).join("、")
          : "等待依赖任务",
      status: dependencyStatus,
    },
    {
      title: "最终审核",
      detail: task.error ?? task.result_summary ?? "待执行",
      status: reviewStatus,
    },
    {
      title: "PR",
      detail: task.pull_request_url ?? "待创建",
      status: task.pull_request_url ? "approved" : "pending",
    },
    {
      title: "合入目标分支",
      detail: task.merged_into ?? "待合入",
      status: task.merged_into ? "approved" : "pending",
    },
    {
      title: "清理资源",
      detail: task.cleanup_summary ?? "待清理",
      status: task.cleanup_summary ? "approved" : "pending",
    },
  ];
  return (
    <section className="task-detail-dialog__section task-detail-dialog__section--wide">
      <h3>审核发布</h3>
      <div className="task-detail-dialog__pipeline task-detail-dialog__pipeline--publish">
        {stages.map((stage, index) => (
          <React.Fragment key={stage.title}>
            {index > 0 ? <span aria-hidden="true">→</span> : null}
            <FlowStage title={stage.title} status={stage.status}>
              {stage.detail}
            </FlowStage>
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function ReviewExchange({ rejected }: { rejected: boolean }) {
  return (
    <div
      className="task-detail-dialog__exchange"
      aria-label="提交审核与反馈退回"
    >
      <span>提交审核 →</span>
      <span>{rejected ? "← 反馈退回" : "← 审核结论"}</span>
    </div>
  );
}

function FlowStage({
  title,
  status,
  children,
}: {
  title: string;
  status: RequirementReviewStatus;
  children: React.ReactNode;
}) {
  return (
    <div className={`task-detail-dialog__stage is-${status}`}>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

function FlowStep({
  title,
  detail,
  status,
}: {
  title: string;
  detail: string;
  status: RequirementReviewStatus;
}) {
  return (
    <div className={`task-detail-dialog__step is-${status}`}>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

const reviewRoundStatusText = {
  reviewing: "审核中",
  approved: "已通过",
  rejected: "已退回",
} as const;

function toReviewStatus(
  status: RequirementExecutionTask["status"],
): RequirementReviewStatus {
  if (status === "approved" || status === "completed") return "approved";
  if (status === "rejected" || status === "failed") return "rejected";
  return "pending";
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
