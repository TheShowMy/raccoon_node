import React, { useEffect, useState } from "react";
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
} from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
  MetadataList,
  MetadataListItem,
} from "@astryxdesign/core/MetadataList";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type {
  RequirementExecutionTask,
  RequirementRecoveryStage,
  RequirementReviewStatus,
  RequirementTaskDetail,
  StartNodeData,
  TraceUsage,
} from "../../types/api";
import { getRequirementTask, getTaskSession } from "../../api/client";
import { readError, tierLabels, traceFromMetadata } from "../../utils/format";
import SessionTranscript from "../ui/SessionTranscript";

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

function taskStatusVariant(status: RequirementExecutionTask["status"]) {
  if (status === "completed" || status === "approved") return "success";
  if (status === "failed" || status === "rejected") return "error";
  if (status === "running" || status === "fixing") return "accent";
  if (status === "awaiting_review") return "warning";
  return "neutral";
}

function taskStatusTokenColor(status: RequirementExecutionTask["status"]) {
  if (status === "completed" || status === "approved") return "green";
  if (status === "failed" || status === "rejected") return "red";
  if (status === "running" || status === "fixing") return "blue";
  if (status === "awaiting_review") return "yellow";
  return "gray";
}

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
              <Button
                label="恢复"
                size="sm"
                variant="secondary"
                icon={<RotateCcw size={13} />}
                className="task-node__recover nowheel nodrag"
                isDisabled={data.busy}
                onClick={() =>
                  void data.onRecoverTaskGroup(data.requirementId, task.id)
                }
              />
            ) : null}
            <Button
              label="详情"
              size="sm"
              variant="ghost"
              icon={<Eye size={13} />}
              className="task-node__detail nowheel nodrag"
              onClick={() => setDetailOpen(true)}
            />
            <IconButton
              label={data.collapsed ? "展开任务组" : "折叠任务组"}
              tooltip={data.collapsed ? "展开任务组" : "折叠任务组"}
              icon={<CollapseIcon size={15} />}
              size="sm"
              variant="ghost"
              className="task-node__collapse nowheel nodrag"
              onClick={() =>
                data.onToggleCollapsed?.(data.requirementId, task.id)
              }
              aria-expanded={!data.collapsed}
            />
          </div>
        </div>
        <TaskDetailDialog
          open={detailOpen}
          requirementId={data.requirementId}
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
              <Button
                label="恢复"
                size="sm"
                variant="secondary"
                icon={<RotateCcw size={13} />}
                className="task-node__recover nowheel nodrag"
                isDisabled={data.busy}
                onClick={() =>
                  void data.onRecoverTaskGroup(data.requirementId, task.id)
                }
              />
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
              <Button
                label="详情"
                size="sm"
                variant="ghost"
                icon={<Eye size={13} />}
                onClick={() => setDetailOpen(true)}
              />
            </div>
          ) : null}
        </div>
      </div>
      {nodeRole === "external" ? (
        <TaskDetailDialog
          open={detailOpen}
          requirementId={data.requirementId}
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
  requirementId,
  task,
  reviews,
  dependencies,
  onClose,
}: {
  open: boolean;
  requirementId: string;
  task: RequirementExecutionTask;
  reviews: RequirementExecutionTask[];
  dependencies: RequirementExecutionTask[];
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<RequirementTaskDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const displayedTask = detail?.task ?? task;
  const displayedReviews = detail?.reviews ?? reviews;
  const displayedDependencies = detail?.dependencies ?? dependencies;
  const historicalTrace = traceFromMetadata(displayedTask.trace);
  const reviewFeedback = buildReviewFeedback(displayedTask, displayedReviews);

  useEffect(() => {
    if (!open) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const loadedDetail = await getRequirementTask(requirementId, task.id);
        if (!cancelled) {
          setDetail(loadedDetail);
          setDetailError(null);
        }
      } catch (reason) {
        if (!cancelled) setDetailError(readError(reason));
      }
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [open, requirementId, task.id]);

  if (!open) return null;

  return createPortal(
    <Dialog
      isOpen={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      className="task-detail-dialog"
      width="min(840px, calc(100vw - 48px))"
      maxHeight="calc(100vh - 48px)"
      padding={0}
      purpose="info"
    >
      <Stack className="task-detail-dialog__panel">
        <DialogHeader
          title={displayedTask.title}
          subtitle={`${taskKindText[displayedTask.kind]}详情`}
          startContent={
            <span className="node-icon task-detail-dialog__icon">
              <CircleDot size={20} />
            </span>
          }
          endContent={
            <Stack direction="horizontal" gap={1.5} align="center">
              <StatusDot
                variant={taskStatusVariant(displayedTask.status)}
                label={taskStatusText[displayedTask.status]}
                isPulsing={displayedTask.status === "running"}
              />
              <Token
                label={taskStatusText[displayedTask.status]}
                color={taskStatusTokenColor(displayedTask.status)}
                size="sm"
              />
            </Stack>
          }
          onOpenChange={(nextOpen) => {
            if (!nextOpen) onClose();
          }}
          hasDivider
        />
        <Stack className="task-detail-dialog__body" gap={3} padding={4}>
          <Section
            className="task-detail-dialog__section task-detail-dialog__section--wide"
            padding={3}
          >
            <Stack gap={1.5}>
              <Text as="h3" type="label" weight="semibold">
                任务描述
              </Text>
              <Text as="p" wordBreak="break-word">
                {displayedTask.description}
              </Text>
            </Stack>
          </Section>
          {historicalTrace?.usage ? (
            <TaskUsage usage={historicalTrace.usage} />
          ) : null}
          {detailError ? (
            <Section variant="muted" padding={3}>
              <Token label={detailError} color="red" size="sm" />
            </Section>
          ) : null}
          <TaskDetailFlow
            task={displayedTask}
            reviews={displayedReviews}
            dependencies={displayedDependencies}
          />
          <Section
            className="task-detail-dialog__section task-detail-dialog__section--wide"
            padding={3}
          >
            <Stack gap={2}>
              <Text as="h3" type="label" weight="semibold">
                会话记录
              </Text>
              <SessionTranscript
                scopeKey={`${requirementId}:${task.id}`}
                loadPage={(before) =>
                  getTaskSession(requirementId, task.id, before)
                }
                title="实现与审核 JSONL 时间线"
                initiallyOpen
              />
            </Stack>
          </Section>
          <Section
            className="task-detail-dialog__section task-detail-dialog__section--wide"
            padding={3}
          >
            <MetadataList
              title={
                <Text as="h3" type="label" weight="semibold">
                  恢复信息
                </Text>
              }
              className="task-detail-dialog__info-list task-detail-dialog__info-list--embedded"
              columns="multi"
            >
              <DetailItem label="失败原因" value={displayedTask.error} danger />
              <DetailItem
                label="失败摘要"
                value={displayedTask.failure_summary}
              />
              <DetailItem
                label="执行失败次数"
                value={String(displayedTask.execution_failure_count)}
              />
              <DetailItem
                label="审核拒绝次数"
                value={String(displayedTask.review_rejection_count)}
              />
              <DetailItem
                label="恢复方案"
                value={displayedTask.recovery_guidance}
                warning
              />
              <DetailItem
                label="当前有效档位"
                value={effectiveTierText(displayedTask)}
              />
            </MetadataList>
          </Section>
          <details className="task-detail-dialog__details">
            <summary>基础信息</summary>
            <MetadataList
              className="task-detail-dialog__info-list"
              columns="multi"
            >
              <DetailItem label="结果" value={displayedTask.result_summary} />
              <DetailItem
                label="执行提示"
                value={displayedTask.execution_warning}
                warning
              />
              <DetailItem label="分支" value={displayedTask.branch_name} />
              <DetailItem
                label="Worktree"
                value={displayedTask.worktree_path}
                mono
              />
              <DetailItem
                label="目标文件"
                value={displayedTask.target_files.join("、")}
              />
              <DetailItem
                label="PR"
                value={displayedTask.pull_request_url}
                href={displayedTask.pull_request_url}
              />
              <DetailItem label="合入分支" value={displayedTask.merged_into} />
              <DetailItem
                label="清理结果"
                value={displayedTask.cleanup_summary}
              />
              <DetailItem label="审核意见" value={reviewFeedback} danger />
            </MetadataList>
          </details>
        </Stack>
      </Stack>
    </Dialog>,
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
    <Section
      className="task-detail-dialog__section task-detail-dialog__section--wide"
      padding={3}
    >
      <Stack gap={2}>
        <Text as="h3" type="label" weight="semibold">
          实现与审核
        </Text>
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
                            review.failure_reason ??
                            review.summary ??
                            "等待审核"
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
                          round.failure_reason ??
                          round.summary ??
                          "等待审核汇总"
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
      </Stack>
    </Section>
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
    <Section
      className="task-detail-dialog__section task-detail-dialog__section--wide"
      padding={3}
    >
      <Stack gap={2}>
        <Text as="h3" type="label" weight="semibold">
          分支合并
        </Text>
        <div className="task-detail-dialog__pipeline">
          <FlowStage title="依赖分支" status={dependencyStatus}>
            {dependencies.length > 0
              ? dependencies.map((dependency) => (
                  <span key={dependency.id}>
                    {dependency.title}
                    {dependency.branch_name
                      ? ` · ${dependency.branch_name}`
                      : ""}
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
      </Stack>
    </Section>
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
  const localMergeCompleted =
    task.pull_request_url === null && task.merged_into !== null;
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
      detail:
        task.pull_request_url ??
        (localMergeCompleted ? "本地仓库，无需 PR" : "待创建"),
      status:
        task.pull_request_url || localMergeCompleted ? "approved" : "pending",
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
    <Section
      className="task-detail-dialog__section task-detail-dialog__section--wide"
      padding={3}
    >
      <Stack gap={2}>
        <Text as="h3" type="label" weight="semibold">
          审核发布
        </Text>
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
      </Stack>
    </Section>
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

function TaskUsage({ usage }: { usage: TraceUsage }) {
  const number = new Intl.NumberFormat("zh-CN");
  const cacheTotal = usage.input + usage.cacheRead;
  const cacheHitRate =
    cacheTotal > 0
      ? `${((usage.cacheRead / cacheTotal) * 100).toFixed(1)}%`
      : "0.0%";

  return (
    <Section
      className="task-detail-dialog__section task-detail-dialog__section--wide"
      padding={3}
    >
      <MetadataList
        title={
          <Text as="h3" type="label" weight="semibold">
            会话统计
          </Text>
        }
        columns="multi"
      >
        <MetadataListItem label="会话是否复用">
          {usage.sessionReused ? "是" : "否"}
        </MetadataListItem>
        <MetadataListItem label="累计调用数">
          {number.format(usage.callCount)} 次
        </MetadataListItem>
        <MetadataListItem label="输入 tokens">
          {number.format(usage.input)}
        </MetadataListItem>
        <MetadataListItem label="输出 tokens">
          {number.format(usage.output)}
        </MetadataListItem>
        <MetadataListItem label="缓存读取">
          {number.format(usage.cacheRead)}
        </MetadataListItem>
        <MetadataListItem label="缓存写入">
          {number.format(usage.cacheWrite)}
        </MetadataListItem>
        <MetadataListItem label="缓存命中率">{cacheHitRate}</MetadataListItem>
        <MetadataListItem label="上下文 tokens">
          {number.format(usage.context.tokens)}
        </MetadataListItem>
        <MetadataListItem label="上下文窗口">
          {number.format(usage.context.window)}
        </MetadataListItem>
        <MetadataListItem label="上下文占比">
          {usage.context.percent.toFixed(1)}%
        </MetadataListItem>
      </MetadataList>
    </Section>
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
    <MetadataListItem label={label}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {value}
        </a>
      ) : (
        <Text
          type={mono ? "code" : "body"}
          color={danger || warning ? "accent" : "primary"}
          wordBreak="break-word"
        >
          {value}
        </Text>
      )}
    </MetadataListItem>
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
