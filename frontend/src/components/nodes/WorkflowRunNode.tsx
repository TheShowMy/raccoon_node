import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { GitBranch, LoaderCircle, RotateCcw, X } from "lucide-react";
import {
  getWorkflowEvents,
  restartWorkflowRunClean,
  resumeWorkflowRun,
} from "../../api/client";
import type {
  StartNodeData,
  WorkflowEvent,
  WorkflowSnapshot,
} from "../../types/api";
import { requirementStatusText } from "../../utils/format";
import { useRequirementPlanningThinking } from "../../contexts/RequirementTaskEventsContext";

const statusText = {
  planning: "规划中",
  running: "执行中",
  validating: "验证中",
  reviewing: "审核中",
  fixing: "集成修复中",
  rescuing: "Rescue 中",
  publishing: "远端发布中",
  paused_technical: "技术暂停",
  completed: "已完成",
  blocked: "永久阻塞",
  cancelled: "已取消",
} as const;

function eventLabel(event: WorkflowEvent) {
  const labels: Record<string, string> = {
    "run.created": "WorkflowRun 已创建",
    "run.workspace_attached": "集成工作区已就绪",
    "run.resumed": "从技术暂停恢复",
    "run.rescue_started": "高级 Rescue 启动",
    "run.rescuing": "高级 Rescue 继续",
    "run.publishing": "进入发布阶段",
    "run.paused_technical": "技术暂停",
    "run.discarded": "污染 Run 已废弃",
    "run.restarted_clean": "已从干净工作区重建",
    "run.completed": "WorkflowRun 完成",
    "run.blocked": "WorkflowRun 永久阻塞",
    "work_item.leased": "行为切片已领取",
    "work_item.fix_requested": "行为切片进入修复",
    "attempt.started": "Agent attempt 启动",
    "attempt.succeeded": "Agent attempt 成功",
    "attempt.failed": "Agent attempt 失败",
    "attempt.superseded": "并行 attempt 已降级",
    "attempt.usage_persisted": "Agent usage 已保存",
    "parallel_batch.serial_fallback": "并行任务降级为串行",
    "parallel_batch.serial_fallback_exhausted": "串行降级已熔断",
    "workspace.boundary_blocked": "工作区越界已熔断",
    "integration.guard_failed": "Integration 守卫失败",
    "item_workspace.prepared": "隔离工作区已创建",
    "item_workspace.integrated": "工作项已汇入 integration",
    "item_workspace.cleaned": "工作项资源已清理",
    "publication.prepared": "发布配置已冻结",
    "publication.pushed": "workflow 分支已推送",
    "publication.review_open": "远端 PR/MR 已创建",
    "publication.waiting_checks": "等待远端检查与合并",
    "publication.checks_changed": "远端检查状态变化",
    "publication.checks_failed": "远端检查失败",
    "publication.merged": "远端合并完成",
    "publication.local_sync_finished": "本地主分支同步处理完成",
    "publication.cleaning": "清理受管资源",
    "publication.cleanup_failed": "受管资源清理失败",
    "publication.completed": "发布与清理完成",
    "validation.completed": "仓库原生验证完成",
    "checkpoint.started": "最终审核启动",
    "checkpoint.review_observed": "审核子 Agent 返回",
    "checkpoint.findings_recorded": "审核 finding 已归并",
    "checkpoint.approved": "审核通过",
    "checkpoint.rejected": "审核发现阻断项",
    "checkpoint.technical_failure": "审核技术失败",
  };
  return labels[event.event_type] ?? event.event_type;
}

function eventDescription(event: WorkflowEvent) {
  for (const key of [
    "reason",
    "failure_message",
    "summary",
    "operation",
    "command",
    "trigger",
  ]) {
    const value = event.payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return `${event.entity_type} · ${event.entity_id}`;
}

function usageTokens(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const direct = [
    "input",
    "output",
    "cache_read",
    "cache_write",
    "cacheRead",
    "cacheWrite",
  ].reduce(
    (total, key) => total + (typeof record[key] === "number" ? record[key] : 0),
    0,
  );
  if (direct > 0) return direct;
  return usageTokens(record.usage) || usageTokens(record.trace);
}

function reviewRecords(workflow: WorkflowSnapshot) {
  return workflow.checkpoints.flatMap((checkpoint) => {
    const details = checkpoint.review_details as
      | {
          reviews?: Array<Record<string, unknown>>;
          selection?: Record<string, unknown>;
        }
      | null
      | undefined;
    return (details?.reviews ?? []).map((review) => ({
      checkpoint,
      review,
      selection: details?.selection,
    }));
  });
}

export default function WorkflowRunNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "workflow-run" }>;
}) {
  const requirement = data.requirement;
  const [workflow, setWorkflow] = useState(data.workflowRun ?? null);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [nextAfter, setNextAfter] = useState<number | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [resuming, setResuming] = useState(false);
  const thinking = useRequirementPlanningThinking();
  const thinkingScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => setWorkflow(data.workflowRun ?? null), [data.workflowRun]);

  useEffect(() => {
    if (thinkingScrollRef.current) {
      thinkingScrollRef.current.scrollLeft =
        thinkingScrollRef.current.scrollWidth;
    }
  }, [thinking]);

  useEffect(() => {
    if (!workflow?.run.id) return;
    let active = true;
    setLoadingEvents(true);
    getWorkflowEvents(workflow.run.id)
      .then((page) => {
        if (!active) return;
        setEvents(page.events);
        setNextAfter(page.next_after);
        setTimelineError(null);
      })
      .catch((error: unknown) => {
        if (active)
          setTimelineError(
            error instanceof Error ? error.message : "读取时间线失败",
          );
      })
      .finally(() => {
        if (active) setLoadingEvents(false);
      });
    return () => {
      active = false;
    };
  }, [workflow?.last_event_sequence, workflow?.run.id]);

  const completedItems =
    workflow?.work_items.filter((item) => item.status === "accepted").length ??
    0;
  const totalItems = workflow?.work_items.length ?? 0;
  const semanticAttempts =
    workflow?.work_items.reduce(
      (total, item) => total + item.attempt_count,
      0,
    ) ?? 0;
  const actualAttempts =
    workflow?.work_items.reduce(
      (total, item) => total + item.actual_attempt_count,
      0,
    ) ?? 0;
  const tokenTotal = useMemo(
    () =>
      workflow
        ? workflow.attempts.reduce(
            (total, attempt) => total + usageTokens(attempt.usage),
            0,
          ) +
          workflow.checkpoints.reduce(
            (total, checkpoint) => total + usageTokens(checkpoint.usage),
            0,
          )
        : 0,
    [workflow],
  );
  const reviews = workflow ? reviewRecords(workflow) : [];
  const requiresCleanRestart =
    workflow?.run.status === "paused_technical" &&
    (workflow.run.paused_operation === "workspace_violation" ||
      workflow.attempts.some(
        (attempt) => attempt.failure_class === "workspace_violation",
      ) ||
      events.some((event) =>
        ["workspace.boundary_blocked", "integration.guard_failed"].includes(
          event.event_type,
        ),
      ) ||
      workflow.attempts.filter(
        (attempt) =>
          attempt.status === "superseded" &&
          attempt.failure_class === "git_conflict",
      ).length >= 2);
  const primaryCause =
    workflow?.run.blocked_reason ??
    [...events]
      .reverse()
      .map(eventDescription)
      .find((message) => message.trim()) ??
    data.actionError ??
    requirement.error;

  const loadMore = async () => {
    if (!workflow || nextAfter == null) return;
    setLoadingEvents(true);
    try {
      const page = await getWorkflowEvents(workflow.run.id, nextAfter);
      setEvents((current) => [...current, ...page.events]);
      setNextAfter(page.next_after);
      setTimelineError(null);
    } catch (error) {
      setTimelineError(
        error instanceof Error ? error.message : "读取时间线失败",
      );
    } finally {
      setLoadingEvents(false);
    }
  };

  const resume = async () => {
    if (!workflow) return;
    setResuming(true);
    try {
      setWorkflow(await resumeWorkflowRun(workflow.run.id));
      setTimelineError(null);
    } catch (error) {
      setTimelineError(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setResuming(false);
    }
  };

  const restartClean = async () => {
    if (!workflow) return;
    setResuming(true);
    try {
      setWorkflow(await restartWorkflowRunClean(workflow.run.id));
      setEvents([]);
      setTimelineError(null);
    } catch (error) {
      setTimelineError(
        error instanceof Error ? error.message : "从干净工作区重新执行失败",
      );
    } finally {
      setResuming(false);
    }
  };

  return (
    <>
      <Toolbar
        label="WorkflowRun Inspector"
        className="nodrag"
        size="sm"
        variant="muted"
        startContent={
          <HStack align="center" gap={3}>
            <Stack style={{ color: "var(--color-accent)" }} aria-hidden>
              <GitBranch size={20} />
            </Stack>
            <Stack gap={0.5}>
              <Text type="label">WorkflowRun Inspector</Text>
              <Text type="supporting" size="3xs">
                {workflow
                  ? statusText[workflow.run.status]
                  : requirementStatusText(requirement.status)}
              </Text>
            </Stack>
          </HStack>
        }
        endContent={
          <IconButton
            label="关闭 WorkflowRun"
            tooltip="关闭 WorkflowRun"
            icon={<X size={14} />}
            size="sm"
            variant="ghost"
            onClick={data.onClose}
          />
        }
      />

      <Stack padding={3} gap={3} className="nodrag nowheel">
        <Stack gap={1}>
          <Text type="label" maxLines={2} wordBreak="break-word">
            {workflow?.run.change_spec.intent ?? requirement.title}
          </Text>
          <HStack gap={1} wrap="wrap">
            <Token
              label={`${completedItems}/${totalItems} 切片`}
              color={
                completedItems === totalItems && totalItems > 0
                  ? "green"
                  : "gray"
              }
              size="sm"
            />
            <Token label={`${tokenTotal} tokens`} color="gray" size="sm" />
            <Token
              label={`语义尝试 ${semanticAttempts} / 实际调用 ${actualAttempts}`}
              color={actualAttempts > semanticAttempts ? "yellow" : "gray"}
              size="sm"
            />
            <Token
              label={
                workflow?.run.rescue_used ? "Rescue 已使用" : "Rescue 未使用"
              }
              color={workflow?.run.rescue_used ? "yellow" : "gray"}
              size="sm"
            />
          </HStack>
          <ProgressBar
            label="WorkflowRun 总体进度"
            value={completedItems}
            max={Math.max(totalItems, 1)}
            isLabelHidden
            variant={
              workflow?.run.status === "completed" ? "success" : "accent"
            }
          />
        </Stack>

        {workflow?.publication ? (
          <Stack gap={1}>
            <Divider label="发布" />
            <HStack gap={1} wrap="wrap">
              <Token
                label={`${workflow.publication.provider} · ${workflow.publication.mode}`}
                color="gray"
                size="sm"
              />
              <Token
                label={workflow.publication.phase}
                color={
                  workflow.publication.phase === "completed" ? "green" : "gray"
                }
                size="sm"
              />
              <Token
                label={`清理 ${workflow.publication.cleanup_status}`}
                color={
                  workflow.publication.cleanup_status === "failed"
                    ? "red"
                    : "gray"
                }
                size="sm"
              />
            </HStack>
            <Text type="supporting" size="3xs" maxLines={2}>
              {workflow.publication.source_branch} →{" "}
              {workflow.publication.target_branch}
            </Text>
            {workflow.publication.local_sync_message ? (
              <Text
                type="supporting"
                size="3xs"
                color={
                  workflow.publication.local_sync_status === "skipped"
                    ? "accent"
                    : undefined
                }
                maxLines={2}
              >
                {workflow.publication.local_sync_message}
              </Text>
            ) : null}
            {workflow.publication.review_url ? (
              <Button
                label="打开远端 PR/MR"
                size="sm"
                variant="ghost"
                onClick={() =>
                  window.open(
                    workflow.publication?.review_url ?? "",
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              />
            ) : null}
          </Stack>
        ) : null}

        {workflow?.run.status === "paused_technical" ? (
          <HStack align="center" gap={2}>
            <StatusDot variant="error" label="技术暂停" />
            <Text type="supporting" size="3xs" maxLines={2}>
              {workflow.run.paused_operation}: {workflow.run.blocked_reason}
            </Text>
            <Button
              label={
                requiresCleanRestart ? "从干净工作区重新执行" : "从暂停位置恢复"
              }
              icon={<RotateCcw size={14} />}
              size="sm"
              variant="secondary"
              isLoading={resuming}
              onClick={requiresCleanRestart ? restartClean : resume}
            />
          </HStack>
        ) : null}

        {primaryCause &&
        workflow &&
        ["paused_technical", "blocked"].includes(workflow.run.status) ? (
          <Stack gap={0.5}>
            <Text type="label" size="2xs">
              Primary cause
            </Text>
            <Text type="supporting" size="3xs" color="accent" maxLines={3}>
              {primaryCause}
            </Text>
          </Stack>
        ) : null}

        <Divider label={`完整时间线 · ${events.length} 条`} />
        <Stack
          gap={1}
          style={{ overflowY: "auto", maxHeight: "var(--spacing-72)" }}
        >
          {events.map((event) => (
            <Stack key={event.sequence} gap={0.5} padding={1}>
              <HStack align="center" gap={1}>
                <StatusDot variant="neutral" label={eventLabel(event)} />
                <Text type="label" size="3xs">
                  {eventLabel(event)}
                </Text>
                <Text type="supporting" size="3xs">
                  #{event.sequence}
                </Text>
              </HStack>
              <Text type="supporting" size="3xs" maxLines={2}>
                {eventDescription(event)}
              </Text>
            </Stack>
          ))}
          {loadingEvents ? (
            <Text type="supporting" size="3xs">
              正在读取时间线…
            </Text>
          ) : null}
          {nextAfter != null ? (
            <Button
              label="加载后续事件"
              size="sm"
              variant="ghost"
              onClick={loadMore}
            />
          ) : null}
          {timelineError ? (
            <Text type="supporting" size="3xs" color="accent">
              {timelineError}
            </Text>
          ) : null}
        </Stack>

        {workflow && workflow.attempts.length > 0 ? (
          <Stack gap={1}>
            <Divider label={`执行尝试 · ${workflow.attempts.length}`} />
            {workflow.attempts.map((attempt) => (
              <Collapsible
                key={attempt.id}
                defaultIsOpen={attempt.status === "failed"}
                trigger={
                  <HStack align="center" gap={2}>
                    <Text type="label" size="3xs">
                      {attempt.kind} · #{attempt.ordinal}
                    </Text>
                    <Token
                      label={attempt.status}
                      color={
                        attempt.status === "succeeded"
                          ? "green"
                          : attempt.status === "failed"
                            ? "red"
                            : "gray"
                      }
                      size="sm"
                    />
                    <Text type="supporting" size="3xs">
                      {attempt.model_tier} · {usageTokens(attempt.usage)} tokens
                    </Text>
                  </HStack>
                }
              >
                <Stack gap={1} padding={2}>
                  {attempt.result_summary ? (
                    <Text type="supporting" size="3xs" maxLines={3}>
                      {attempt.result_summary}
                    </Text>
                  ) : null}
                  {attempt.failure_message ? (
                    <Text type="supporting" size="3xs" color="accent">
                      {attempt.failure_class}: {attempt.failure_message}
                    </Text>
                  ) : null}
                  {attempt.status !== "running" ? (
                    <Button
                      label="查看 session JSONL"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        window.open(
                          `/api/workflow-runs/${encodeURIComponent(workflow.run.id)}/attempts/${encodeURIComponent(attempt.id)}/session`,
                          "_blank",
                          "noopener,noreferrer",
                        )
                      }
                    />
                  ) : null}
                </Stack>
              </Collapsible>
            ))}
          </Stack>
        ) : null}

        {workflow && workflow.validations.length > 0 ? (
          <Stack gap={1}>
            <Divider label={`仓库原生验证 · ${workflow.validations.length}`} />
            {workflow.validations.map((validation) => (
              <Collapsible
                key={validation.id}
                defaultIsOpen={
                  validation.baseline_status === "passed" &&
                  validation.final_status === "failed"
                }
                trigger={
                  <HStack align="center" gap={2}>
                    <Text type="label" size="3xs">
                      {validation.command}
                    </Text>
                    <Token
                      label={`${validation.baseline_status} → ${validation.final_status}`}
                      color={
                        validation.baseline_status === "passed" &&
                        validation.final_status === "failed"
                          ? "red"
                          : "gray"
                      }
                      size="sm"
                    />
                  </HStack>
                }
              >
                <Stack gap={1} padding={2}>
                  <Text type="supporting" size="3xs">
                    {validation.source} ·{" "}
                    {validation.gating ? "gate" : "observation"}
                  </Text>
                  {validation.output_summary ? (
                    <Text type="supporting" size="3xs" maxLines={5}>
                      {validation.output_summary}
                    </Text>
                  ) : null}
                </Stack>
              </Collapsible>
            ))}
          </Stack>
        ) : null}

        {reviews.length > 0 ? (
          <Stack gap={1}>
            <Divider label={`审核子 Agent · ${reviews.length}`} />
            {reviews.map(({ checkpoint, review, selection }, index) => {
              const angle = String(review.angle ?? "审核");
              const transport = String(review.transport_status ?? "unknown");
              const result = review.result as
                | { findings?: Array<Record<string, unknown>> }
                | undefined;
              const findings = result?.findings ?? [];
              return (
                <Collapsible
                  key={`${checkpoint.id}-${angle}-${index}`}
                  defaultIsOpen={transport !== "completed"}
                  trigger={
                    <HStack align="center" gap={2}>
                      <Text type="label" size="3xs">
                        {angle}
                      </Text>
                      <Token
                        label={transport}
                        color={transport === "completed" ? "green" : "red"}
                        size="sm"
                      />
                      <Text type="supporting" size="3xs">
                        {String(review.context_mode ?? "blind")} ·{" "}
                        {findings.length} findings
                      </Text>
                    </HStack>
                  }
                >
                  <Stack gap={1} padding={2}>
                    <Text type="supporting" size="3xs">
                      耗时 {String(review.duration_ms ?? 0)} ms · 修正提交{" "}
                      {String(review.submission_correction_count ?? 0)} 次 ·
                      重试 {String(review.retry_count ?? 0)} 次 ·{" "}
                      {usageTokens(review.usage)} tokens
                    </Text>
                    <Text type="supporting" size="3xs">
                      context {String(review.context_bytes ?? 0)} bytes · hash{" "}
                      {String(review.context_hash ?? "-")}
                    </Text>
                    {selection ? (
                      <Text type="supporting" size="3xs" maxLines={4}>
                        选择原因：
                        {Array.isArray(selection.reasons)
                          ? selection.reasons.join("；")
                          : "-"}
                        ；跳过：
                        {Array.isArray(selection.skippedAngles)
                          ? selection.skippedAngles.join("、") || "无"
                          : "-"}
                      </Text>
                    ) : null}
                    {review.runtime && typeof review.runtime === "object" ? (
                      <Text type="supporting" size="3xs">
                        活动{" "}
                        {String(
                          (review.runtime as Record<string, unknown>)
                            .activityCount ?? 0,
                        )}{" "}
                        次 · 空闲告警{" "}
                        {String(
                          (review.runtime as Record<string, unknown>)
                            .idleWarningCount ?? 0,
                        )}{" "}
                        次
                      </Text>
                    ) : null}
                    {findings.map((finding, findingIndex) => (
                      <Text
                        key={`${String(finding.path ?? "finding")}-${findingIndex}`}
                        type="supporting"
                        size="3xs"
                        color={
                          ["P0", "P1"].includes(String(finding.priority))
                            ? "accent"
                            : undefined
                        }
                        maxLines={3}
                      >
                        {String(finding.priority)} · {String(finding.summary)}
                      </Text>
                    ))}
                    {review.error ? (
                      <Text type="supporting" size="3xs" color="accent">
                        {String(review.error)}
                      </Text>
                    ) : null}
                  </Stack>
                </Collapsible>
              );
            })}
          </Stack>
        ) : null}

        {workflow && workflow.findings.length > 0 ? (
          <Stack gap={1}>
            <Divider label={`Finding ledger · ${workflow.findings.length}`} />
            {workflow.findings.map((finding) => (
              <HStack key={finding.id} align="center" gap={2}>
                <Token
                  label={`${finding.priority} · ${finding.status}`}
                  color={
                    finding.status === "open" &&
                    ["P0", "P1"].includes(finding.priority)
                      ? "red"
                      : "gray"
                  }
                  size="sm"
                />
                <Text type="supporting" size="3xs" maxLines={2}>
                  {finding.angle} · {finding.summary}
                </Text>
              </HStack>
            ))}
          </Stack>
        ) : null}
      </Stack>

      {requirement.status === "planning" ? (
        <HStack
          align="center"
          gap={2}
          padding={2}
          paddingInline={3}
          style={{ minHeight: 0, borderTop: "1px solid var(--color-border)" }}
        >
          <HStack align="center" gap={1} style={{ flexShrink: 0 }}>
            <LoaderCircle size={12} aria-hidden="true" />
            <Text type="supporting" size="3xs">
              思考
            </Text>
          </HStack>
          <Stack
            ref={thinkingScrollRef}
            className="nodrag nowheel"
            style={{ overflowX: "auto", minWidth: 0 }}
          >
            <Text type="supporting" size="3xs" maxLines={1}>
              {thinking || "思考中…"}
            </Text>
          </Stack>
        </HStack>
      ) : null}

      <Handle
        id="workflow-run-entry"
        type="source"
        position={Position.Right}
        className="node-link-handle node-link-handle--requirement dag-node__entry-handle"
      />
    </>
  );
}
