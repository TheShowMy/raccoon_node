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
  ModelTierKey,
  StartNodeData,
  WorkflowEvent,
  WorkflowSnapshot,
} from "../../types/api";
import {
  findingPriorityText,
  requirementStatusText,
  reviewAngleText,
  tierLabels,
  validationStatusText,
  workflowAttemptKindText,
  workflowAttemptStatusText,
  workflowCleanupStatusText,
  workflowEventLabel,
  workflowLocalSyncStatusText,
  workflowPublicationModeText,
  workflowPublicationPhaseText,
  workflowPublicationProviderText,
  workflowRunStatusText,
} from "../../utils/format";
import { useRequirementPlanningThinking } from "../../contexts/RequirementTaskEventsContext";

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
    const details = checkpoint.review_details;
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
        setEvents(page.events.slice().reverse());
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
      setEvents((current) => [...current, ...page.events.slice().reverse()]);
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
        label="工作流运行检查器"
        className="nodrag"
        size="sm"
        variant="muted"
        startContent={
          <HStack align="center" gap={3}>
            <Stack style={{ color: "var(--color-accent)" }} aria-hidden>
              <GitBranch size={20} />
            </Stack>
            <Stack gap={0.5}>
              <Text type="label">工作流运行检查器</Text>
              <Text type="supporting" size="3xs">
                {workflow
                  ? workflowRunStatusText(workflow.run.status)
                  : requirementStatusText(requirement.status)}
              </Text>
            </Stack>
          </HStack>
        }
        endContent={
          <IconButton
            label="关闭"
            tooltip="关闭"
            icon={<X size={14} />}
            size="sm"
            variant="ghost"
            onClick={data.onClose}
          />
        }
      />

      <Stack
        padding={3}
        gap={3}
        isScrollable
        className="nodrag nowheel workflow-run-content"
      >
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
            <Token label={`${tokenTotal} token 数`} color="gray" size="sm" />
            <Token
              label={`语义尝试 ${semanticAttempts} / 实际调用 ${actualAttempts}`}
              color={actualAttempts > semanticAttempts ? "yellow" : "gray"}
              size="sm"
            />
            <Token
              label={
                workflow?.run.rescue_used ? "深度修复已使用" : "深度修复未使用"
              }
              color={workflow?.run.rescue_used ? "yellow" : "gray"}
              size="sm"
            />
          </HStack>
          <ProgressBar
            label="总体进度"
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
                label={`${workflowPublicationProviderText(workflow.publication.provider)} · ${workflowPublicationModeText(workflow.publication.mode)}`}
                color="gray"
                size="sm"
              />
              <Token
                label={workflowPublicationPhaseText(workflow.publication.phase)}
                color={
                  workflow.publication.phase === "completed" ? "green" : "gray"
                }
                size="sm"
              />
              <Token
                label={`清理 ${workflowCleanupStatusText(workflow.publication.cleanup_status)}`}
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
                {workflowLocalSyncStatusText(
                  workflow.publication.local_sync_status,
                )}
                : {workflow.publication.local_sync_message}
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
              主要原因
            </Text>
            <Text type="supporting" size="3xs" color="accent" maxLines={3}>
              {primaryCause}
            </Text>
          </Stack>
        ) : null}

        <Divider label={`事件时间线 · ${events.length} 条`} />
        <Stack gap={1} className="nodrag nowheel">
          {events.map((event) => (
            <Stack key={event.sequence} gap={0.5} padding={1}>
              <HStack align="center" gap={1}>
                <StatusDot
                  variant="neutral"
                  label={workflowEventLabel(event.event_type)}
                />
                <Text type="label" size="3xs">
                  {workflowEventLabel(event.event_type)}
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
              label="加载更早事件"
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
                      {workflowAttemptKindText(attempt.kind)} · #
                      {attempt.ordinal}
                    </Text>
                    <Token
                      label={workflowAttemptStatusText(attempt.status)}
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
                      {tierLabels[attempt.model_tier as ModelTierKey] ??
                        attempt.model_tier}{" "}
                      · {usageTokens(attempt.usage)} token 数
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
                      label="查看会话日志"
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
            <Divider label={`仓库检查 · ${workflow.validations.length}`} />
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
                      label={`${validationStatusText(validation.baseline_status)} → ${validationStatusText(validation.final_status)}`}
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
                    {validation.source === "repository_catalog"
                      ? "仓库命令"
                      : "运行观察"}
                    · {validation.gating ? "门槛检查" : "观察"}
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
            <Divider label={`代码审核 · ${reviews.length}`} />
            {reviews.map(({ checkpoint, review, selection }, index) => {
              const angle = review.angle;
              const transport = review.transport_status;
              const findings = (workflow?.findings ?? []).filter(
                (finding) =>
                  finding.checkpoint_id === checkpoint.id &&
                  finding.angle === angle,
              );
              return (
                <Collapsible
                  key={`${checkpoint.id}-${angle}-${index}`}
                  defaultIsOpen={transport !== "completed"}
                  trigger={
                    <HStack align="center" gap={2}>
                      <Text type="label" size="3xs">
                        {reviewAngleText(angle)}
                      </Text>
                      <Token
                        label={transport === "completed" ? "已完成" : "失败"}
                        color={transport === "completed" ? "green" : "red"}
                        size="sm"
                      />
                      <Text type="supporting" size="3xs">
                        {findings.length} 个问题
                      </Text>
                    </HStack>
                  }
                >
                  <Stack gap={1} padding={2}>
                    <Text type="supporting" size="3xs">
                      耗时 {review.duration_ms} ms · 修正提交{" "}
                      {review.submission_correction_count} 次 · 重试{" "}
                      {review.retry_count} 次 · {usageTokens(review.usage)}{" "}
                      token 数
                    </Text>
                    {selection ? (
                      <Text type="supporting" size="3xs" maxLines={4}>
                        选择原因：
                        {selection.reasons.join("；") || "-"}
                        ；跳过：
                        {selection.skipped_angles
                          .map(reviewAngleText)
                          .join("、") || "无"}
                      </Text>
                    ) : null}
                    {review.runtime ? (
                      <Text type="supporting" size="3xs">
                        活动 {review.runtime.activity_count} 次 · 空闲告警{" "}
                        {review.runtime.warning_count} 次
                      </Text>
                    ) : null}
                    {findings.map((finding, findingIndex) => (
                      <Text
                        key={`${finding.path ?? "finding"}-${findingIndex}`}
                        type="supporting"
                        size="3xs"
                        color={
                          finding.priority === "P0" || finding.priority === "P1"
                            ? "accent"
                            : undefined
                        }
                        maxLines={3}
                      >
                        {findingPriorityText(finding.priority)} ·{" "}
                        {finding.summary}
                      </Text>
                    ))}
                    {review.error ? (
                      <Text type="supporting" size="3xs" color="accent">
                        {review.error}
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
            <Divider label={`审核问题 · ${workflow.findings.length}`} />
            {workflow.findings.map((finding) => (
              <HStack key={finding.id} align="center" gap={2}>
                <Token
                  label={`${findingPriorityText(finding.priority)} · ${finding.status === "open" ? "未解决" : "已解决"}`}
                  color={
                    finding.status === "open" &&
                    (finding.priority === "P0" || finding.priority === "P1")
                      ? "red"
                      : "gray"
                  }
                  size="sm"
                />
                <Text type="supporting" size="3xs" maxLines={2}>
                  {reviewAngleText(finding.angle)} · {finding.summary}
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
