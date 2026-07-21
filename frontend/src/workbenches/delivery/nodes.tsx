import { PixelButton } from "@pxlkit/ui-kit";
import type { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { getApi } from "../../api";
import {
  groupRequirements,
  REQUIREMENT_GROUP_LABELS,
  REQUIREMENT_GROUP_ORDER,
  type RequirementGroupKey,
} from "../../api/groups";
import { DEMO_MERGE_DIFF } from "../../api/mock/demoContent";
import { qualitySummary, RUN_PHASE_LABELS } from "../../api/quality";
import { evaluateRunBudget } from "../../api/usage";
import type {
  PendingAction,
  Publication,
  Requirement,
  RequirementRevision,
  Run,
  RunReview,
  RunValidation,
  WorkItem,
  WorkPlan,
} from "../../api/types";
import { DiffView } from "../../components/DiffView";
import { DNode } from "../../components/DNode";
import { useDeliveryStore } from "../../store/deliveryStore";
import { useDomainStore } from "../../store/domainStore";
import { deliveryNodeId, layoutWorkItems, runLocateTarget } from "./projection";

/* ── 共享外壳在 src/components/DNode.tsx（P3 起各工作台共用） ── */

const TONE_BY_VERDICT: Record<string, string> = {
  clean: "green",
  approved: "green",
  baseline_issues_only: "yellow",
  approved_with_advisories: "yellow",
  new_regression: "red",
  blocking_findings: "red",
  unavailable: "gray",
};

const PATH_LABELS = {
  local: "本地主分支 fast-forward",
  github_pull_request: "GitHub PR",
  gitlab_merge_request: "GitLab MR",
} as const;

function Meta({ children }: { children: React.ReactNode }) {
  return <p className="dnode__meta">{children}</p>;
}

/* ── 需求列表（空间锚点，FE-DELIVERY-002） ── */

function RequirementListInner() {
  const requirements = useDomainStore((state) => state.requirements);
  const runs = useDomainStore((state) => state.runs);
  const validations = useDomainStore((state) => state.validations);
  const reviews = useDomainStore((state) => state.reviews);
  const selectedId = useDeliveryStore((state) => state.selectedRequirementId);
  const search = useDeliveryStore((state) => state.search);
  const groupFilter = useDeliveryStore((state) => state.groupFilter);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const reorderMutation = useMutation({
    mutationFn: (requirementIds: string[]) =>
      getApi().reorderQueue({ requirement_ids: requirementIds }),
  });

  const groups = groupRequirements(Object.values(requirements), runs);
  const visible = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((requirement) =>
        search.trim() ? requirement.title.includes(search.trim()) : true,
      ),
    }))
    .filter(
      (group) =>
        (!groupFilter || group.key === groupFilter) && group.items.length > 0,
    );

  const move = (group: RequirementGroupKey, index: number, delta: -1 | 1) => {
    const queued = groups.find((entry) => entry.key === group);
    if (!queued) return;
    const target = index + delta;
    if (target < 0 || target >= queued.items.length) return;
    const ids = queued.items.map((requirement) => requirement.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorderMutation.mutate(ids);
  };

  return (
    <div className="req-list">
      <div className="req-list__controls nodrag nowheel">
        <input
          className="dnode__input"
          type="search"
          aria-label="搜索需求"
          placeholder="搜索标题…"
          value={search}
          onChange={(event) =>
            useDeliveryStore.getState().setSearch(event.target.value)
          }
        />
        <div className="req-list__filters" role="group" aria-label="分组筛选">
          <button
            type="button"
            data-active={groupFilter === null || undefined}
            onClick={() => useDeliveryStore.getState().setGroupFilter(null)}
          >
            全部
          </button>
          {REQUIREMENT_GROUP_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              data-active={groupFilter === key || undefined}
              onClick={() =>
                useDeliveryStore
                  .getState()
                  .setGroupFilter(groupFilter === key ? null : key)
              }
            >
              {REQUIREMENT_GROUP_LABELS[key]}
            </button>
          ))}
        </div>
      </div>
      <div className="req-list__scroll nodrag nowheel">
        {visible.length === 0 ? (
          <Meta>
            暂无需求：在对话中描述开发目标，或在回答节点「整理为需求」。
          </Meta>
        ) : (
          visible.map((group) => (
            <section key={group.key} className="req-list__group">
              <h4 className="req-list__group-title">
                {group.key === "history" ? (
                  <button
                    type="button"
                    aria-expanded={historyExpanded || groupFilter === "history"}
                    onClick={() => setHistoryExpanded((current) => !current)}
                  >
                    {historyExpanded || groupFilter === "history" ? "▾" : "▸"}{" "}
                    {group.label}（{group.items.length}）
                  </button>
                ) : (
                  <>
                    {group.label}（{group.items.length}）
                  </>
                )}
              </h4>
              <ul
                className="req-list__items"
                hidden={
                  group.key === "history" &&
                  !historyExpanded &&
                  groupFilter !== "history"
                }
              >
                {group.items.map((requirement, index) => {
                  const run = requirement.latest_run_id
                    ? runs[requirement.latest_run_id]
                    : undefined;
                  return (
                    <li key={requirement.id} className="req-list__item-row">
                      <button
                        type="button"
                        className="req-list__item"
                        data-selected={
                          requirement.id === selectedId || undefined
                        }
                        onClick={() =>
                          useDeliveryStore
                            .getState()
                            .selectRequirement(requirement.id)
                        }
                      >
                        <span className="req-list__item-title">
                          {requirement.title}
                        </span>
                        <span className="req-list__item-meta">
                          {group.label}
                          {requirement.queue_position
                            ? ` · #${requirement.queue_position}`
                            : ""}
                          {run && run.phase !== "terminal"
                            ? ` · ${RUN_PHASE_LABELS[run.phase]}`
                            : ""}
                          {run?.outcome
                            ? ` · ${qualitySummary({
                                run,
                                validation: run
                                  ? (validations[run.id] ?? null)
                                  : null,
                                review: run ? (reviews[run.id] ?? null) : null,
                              })}`
                            : ""}
                        </span>
                      </button>
                      {group.key === "queued" ? (
                        <span className="req-list__moves">
                          <button
                            type="button"
                            aria-label={`上移 ${requirement.title}`}
                            disabled={reorderMutation.isPending || index === 0}
                            onClick={() => move(group.key, index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`下移 ${requirement.title}`}
                            disabled={
                              reorderMutation.isPending ||
                              index === group.items.length - 1
                            }
                            onClick={() => move(group.key, index, 1)}
                          >
                            ↓
                          </button>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
      <Meta>只有执行队列可重排；进行中与阻断项不可移动。</Meta>
    </div>
  );
}

export const RequirementListNode = memo(function RequirementListNode() {
  return (
    <DNode icon="requirement" label="需求列表" width={300} ariaLabel="需求列表">
      <RequirementListInner />
    </DNode>
  );
});

/* ── 已确认需求摘要：只展示需求内容，不再提供跳回对话的入口 ── */

export const RequirementSummaryNode = memo(function RequirementSummaryNode({
  data,
}: NodeProps) {
  const { requirement, revision } = data as {
    requirement: Requirement;
    revision: RequirementRevision | null;
  };
  return (
    <DNode
      icon="requirement"
      label="确定需求"
      chip={`r${requirement.confirmed_revision ?? requirement.latest_revision}`}
      chipTone="green"
      width={340}
      ariaLabel={`确定需求：${requirement.title}`}
    >
      <p className="dnode__text">{revision?.spec.goal || requirement.title}</p>
      <Meta>
        队列位置：
        {requirement.queue_position ? `#${requirement.queue_position}` : "历史"}
      </Meta>
    </DNode>
  );
});

/* ── Run（FE-RUN-002：阶段、产出、风险、下一步；组合表达禁止单一"完成"） ── */

const RUN_RAIL: Run["phase"][] = [
  "queued",
  "waiting_workspace",
  "planning",
  "executing",
  "validating",
  "reviewing",
  "publishing",
  "terminal",
];

function nextStepHint(run: Run): string {
  switch (run.phase) {
    case "queued":
      return "等待仓库写锁（FIFO）。";
    case "waiting_workspace":
      return "执行尚未开始：清理主工作区后自动继续，问答与需求准备不受影响。";
    case "executing":
      return "自动执行中；可请求暂停（进行中的工作项完成后进入 paused）。";
    case "pausing":
      return "等待进行中的工作项完成。";
    case "paused":
      return "可编辑 pending 工作项、依赖与验证目标，然后恢复。";
    case "blocked":
      return "需要你的决定：重试（重置修复上限）或放弃（确认链转终态）。";
    case "terminal":
      return "已结束。";
    default:
      return "自动进行中。";
  }
}

export const RunNode = memo(function RunNode({ data }: NodeProps) {
  const { run, requirement, validation, review, activeWorkItemId } = data as {
    run: Run;
    requirement: Requirement;
    validation: RunValidation | null;
    review: RunReview | null;
    activeWorkItemId: string | null;
  };
  const pauseMutation = useMutation({
    mutationFn: () => getApi().pauseRun(run.id),
  });
  const resumeMutation = useMutation({
    mutationFn: () => getApi().resumeRun(run.id),
  });
  const retryMutation = useMutation({
    mutationFn: () => getApi().retryRun(run.id),
  });
  const abandonMutation = useMutation({
    mutationFn: () =>
      getApi().requestAction({ kind: "abandon_run", run_id: run.id }),
  });
  const usage = useDomainStore((state) => state.usage);
  const budget = usage
    ? evaluateRunBudget(usage, run.id, run.task_budget_usd)
    : null;
  const railIndex = RUN_RAIL.includes(run.phase)
    ? RUN_RAIL.indexOf(run.phase)
    : run.resume_phase
      ? RUN_RAIL.indexOf(run.resume_phase)
      : 0;
  const locateTarget = runLocateTarget(run, activeWorkItemId);
  return (
    <DNode
      icon="run"
      label="Run"
      chip={
        run.phase === "blocked" || run.phase === "paused"
          ? RUN_PHASE_LABELS[run.phase]
          : run.outcome
            ? `${RUN_PHASE_LABELS.terminal} · ${run.outcome}`
            : RUN_PHASE_LABELS[run.phase]
      }
      chipTone={
        run.phase === "blocked"
          ? "red"
          : run.phase === "paused" || run.phase === "waiting_workspace"
            ? "yellow"
            : run.outcome === "delivered"
              ? "green"
              : run.phase === "terminal"
                ? "gray"
                : "cyan"
      }
      width={360}
      ariaLabel={`Run 节点：${RUN_PHASE_LABELS[run.phase]}`}
      actions={
        <>
          {locateTarget ? (
            <PixelButton
              size="sm"
              variant="outline"
              onClick={() =>
                useDeliveryStore.getState().requestFocus(locateTarget.nodeId)
              }
            >
              {locateTarget.label}
            </PixelButton>
          ) : null}
          <PixelButton
            size="sm"
            variant="outline"
            onClick={() =>
              useDeliveryStore.getState().toggleDiagnostics(run.id)
            }
          >
            诊断
          </PixelButton>
          {run.phase === "executing" ? (
            <PixelButton
              size="sm"
              variant="outline"
              disabled={pauseMutation.isPending}
              onClick={() => pauseMutation.mutate()}
            >
              请求暂停
            </PixelButton>
          ) : null}
          {run.phase === "paused" ? (
            <PixelButton
              size="sm"
              tone="cyan"
              disabled={resumeMutation.isPending}
              onClick={() => resumeMutation.mutate()}
            >
              恢复
            </PixelButton>
          ) : null}
          {run.phase === "blocked" ? (
            <>
              <PixelButton
                size="sm"
                tone="cyan"
                disabled={retryMutation.isPending}
                onClick={() => retryMutation.mutate()}
              >
                重试
              </PixelButton>
              <PixelButton
                size="sm"
                tone="red"
                variant="outline"
                disabled={abandonMutation.isPending}
                onClick={() => abandonMutation.mutate()}
              >
                放弃…
              </PixelButton>
            </>
          ) : null}
          <PixelButton
            size="sm"
            variant="outline"
            onClick={() => {
              const store = useDeliveryStore.getState();
              store.selectRequirement(null);
              store.requestFocus(deliveryNodeId.list());
            }}
          >
            关闭
          </PixelButton>
        </>
      }
    >
      <ol className="dnode__rail" aria-label="Run 阶段">
        {RUN_RAIL.map((phase, index) => (
          <li
            key={phase}
            data-current={phase === run.phase || undefined}
            data-done={index < railIndex || undefined}
          >
            {RUN_PHASE_LABELS[phase]}
          </li>
        ))}
      </ol>
      <p className="dnode__text">
        <strong>{qualitySummary({ run, validation, review })}</strong>
      </p>
      <p className="dnode__text">
        任务预算 ${run.task_budget_usd.toFixed(2)} · 已知费用 $
        {(budget?.known_cost_usd ?? 0).toFixed(2)}
        {budget?.incomplete_entries
          ? ` · ${budget.incomplete_entries} 条价格不完整`
          : ""}
        {budget?.warning ? " · 已达到 80% 软告警" : ""}
      </p>
      {run.current_activity ? (
        <p className="dnode__text">{run.current_activity}</p>
      ) : null}
      {run.blocked_reason ? (
        <p className="dnode__warning" role="alert">
          阻断：{run.blocked_reason}
        </p>
      ) : null}
      {run.cancel_reason ? <Meta>取消原因:{run.cancel_reason}</Meta> : null}
      <Meta>
        需求:{requirement.title} · 规格 r{run.requirement_revision}
      </Meta>
      <Meta>下一步:{nextStepHint(run)}</Meta>
    </DNode>
  );
});

/* ── WorkPlan（PRD-RUN-003/005：DAG + 校验结果） ── */

export const WorkPlanNode = memo(function WorkPlanNode({ data }: NodeProps) {
  const { plan, run } = data as { plan: WorkPlan; run: Run };
  const workItems = plan.items.filter((item) => item.kind === "work_item");
  const mergeTasks = plan.items.filter((item) => item.kind === "merge_task");
  const coveredScenarios = new Set(
    workItems.flatMap((item) => item.scenario_ids),
  );
  return (
    <DNode
      icon="plan"
      label="WorkPlan"
      chip={`rev ${plan.revision}${plan.validation.ok ? "" : " · 校验失败"}`}
      chipTone={plan.validation.ok ? "cyan" : "red"}
      width={340}
      ariaLabel="WorkPlan 节点"
    >
      <Meta>
        {workItems.length} 个工作项 · {mergeTasks.length} 个显式合并任务 ·
        场景覆盖 {[...coveredScenarios].join("、") || "无"}
      </Meta>
      <Meta>
        同层最多 3 个并行；每个并行批后自动插入合并任务（PRD-RUN-006）。
      </Meta>
      {run.phase === "paused" ? (
        <Meta>
          已暂停：pending 工作项可在各自节点内编辑，保存生成新 revision。
        </Meta>
      ) : null}
      {plan.validation.ok ? (
        <Meta>DAG / 场景覆盖 / 并行安全校验通过。</Meta>
      ) : (
        <ul className="dnode__lines dnode__lines--alert">
          {plan.validation.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </DNode>
  );
});

export const PlanInvalidNode = memo(function PlanInvalidNode({
  data,
}: NodeProps) {
  const { issues } = data as { plan: WorkPlan; issues: string[] };
  return (
    <DNode
      icon="diag"
      label="计划无效"
      chip="禁止执行"
      chipTone="red"
      width={380}
      ariaLabel="计划无效节点"
      className="dnode--danger"
    >
      <p className="dnode__warning" role="alert">
        当前依赖关系无法形成可信 DAG，不绘制误导性任务连线。
      </p>
      <ul className="dnode__lines dnode__lines--alert">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </DNode>
  );
});

export const StageBandNode = memo(function StageBandNode({ data }: NodeProps) {
  const { label } = data as { label: string };
  return (
    <div className="delivery-stage-band" aria-hidden="true">
      <span className="px-font-pixel">{label}</span>
    </div>
  );
});

/* ── 工作项 / 合并任务 ── */

const WORK_ITEM_STATUS_LABELS: Record<WorkItem["status"], string> = {
  pending: "待执行",
  running: "进行中",
  completed: "完成",
  failed: "失败",
  blocked: "阻断",
};

const ATTEMPT_KIND_LABELS: Record<
  WorkItem["attempts"][number]["kind"],
  string
> = {
  implementation: "实现",
  fix: "修复",
  rescue: "rescue",
};

export const WorkItemNode = memo(function WorkItemNode({ data }: NodeProps) {
  const { item, runPhase, runId, planItems } = data as {
    item: WorkItem;
    runPhase: Run["phase"];
    runId: string;
    planItems: WorkItem[];
  };
  const editable = runPhase === "paused" && item.status === "pending";
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<"summary" | "attempts" | "artifact">(
    "summary",
  );
  const [title, setTitle] = useState(item.title);
  const [scenarios, setScenarios] = useState(item.scenario_ids.join(","));
  const [target, setTarget] = useState(item.verification_target);
  const [dependencies, setDependencies] = useState(item.depends_on);
  const draftItems = planItems.map((candidate) =>
    candidate.id === item.id
      ? { ...candidate, depends_on: dependencies }
      : candidate,
  );
  const dependencyIssues = layoutWorkItems(draftItems).issues;
  if (
    item.kind === "work_item" &&
    dependencies.some((id) => {
      const dependency = planItems.find((candidate) => candidate.id === id);
      return (
        dependency?.kind === "work_item" && dependency.batch === item.batch
      );
    })
  ) {
    dependencyIssues.push("同一并行批的工作项不能互相依赖");
  }
  const updateMutation = useMutation({
    mutationFn: () =>
      getApi().updateWorkItem({
        run_id: runId,
        item_id: item.id,
        patch: {
          title,
          scenario_ids: scenarios
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          verification_target: target,
          depends_on: dependencies,
        },
      }),
    onSuccess: () => setEditing(false),
  });
  const save = () => {
    if (dependencyIssues.length > 0) return;
    updateMutation.mutate();
  };
  return (
    <DNode
      icon={item.kind === "merge_task" ? "merge" : "workitem"}
      label={
        item.kind === "merge_task" ? "合并任务" : `工作项 #${item.position}`
      }
      chip={WORK_ITEM_STATUS_LABELS[item.status]}
      chipTone={
        item.status === "completed"
          ? "green"
          : item.status === "running"
            ? "cyan"
            : item.status === "pending"
              ? "gray"
              : "red"
      }
      width={360}
      height={item.kind === "merge_task" ? 160 : 208}
      className="dnode--work-item"
      ariaLabel={`${item.kind === "merge_task" ? "合并任务" : "工作项"}：${item.title}`}
      actions={
        editable && !editing ? (
          <PixelButton
            size="sm"
            variant="outline"
            onClick={() => setEditing(true)}
          >
            编辑（paused）
          </PixelButton>
        ) : null
      }
    >
      <div className="work-item-tabs" role="tablist" aria-label="任务详情">
        {(["summary", "attempts", "artifact"] as const).map((next) => (
          <button
            key={next}
            type="button"
            role="tab"
            aria-selected={tab === next}
            data-active={tab === next || undefined}
            onClick={() => setTab(next)}
          >
            {next === "summary"
              ? "概要"
              : next === "attempts"
                ? "尝试"
                : "产物"}
          </button>
        ))}
      </div>
      <div className="work-item-body nodrag nowheel">
        {editing ? (
          <div className="dnode__inline-form nodrag nowheel">
            <input
              className="dnode__input"
              aria-label="工作项标题"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <input
              className="dnode__input"
              aria-label="场景引用（逗号分隔）"
              value={scenarios}
              onChange={(event) => setScenarios(event.target.value)}
            />
            <input
              className="dnode__input"
              aria-label="验证目标"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
            <fieldset className="work-item-dependencies">
              <legend>前置任务</legend>
              {planItems
                .filter((candidate) => candidate.id !== item.id)
                .map((candidate) => (
                  <label key={candidate.id}>
                    <input
                      type="checkbox"
                      checked={dependencies.includes(candidate.id)}
                      onChange={(event) =>
                        setDependencies((current) =>
                          event.target.checked
                            ? [...current, candidate.id]
                            : current.filter((id) => id !== candidate.id),
                        )
                      }
                    />
                    #{candidate.position} {candidate.title}
                  </label>
                ))}
            </fieldset>
            <span className="dnode__chips">
              <PixelButton
                size="sm"
                tone="green"
                disabled={
                  dependencyIssues.length > 0 || updateMutation.isPending
                }
                onClick={() => void save()}
              >
                保存（新 revision）
              </PixelButton>
              <PixelButton
                size="sm"
                variant="outline"
                onClick={() => setEditing(false)}
              >
                取消
              </PixelButton>
            </span>
            {dependencyIssues.length > 0 ? (
              <p className="dnode__warning" role="alert">
                {dependencyIssues[0]}
              </p>
            ) : null}
          </div>
        ) : tab === "summary" ? (
          <>
            <p className="dnode__text">{item.title}</p>
            {item.scope_hint ? <Meta>范围:{item.scope_hint}</Meta> : null}
            {item.scenario_ids.length > 0 ? (
              <Meta>场景:{item.scenario_ids.join("、")}</Meta>
            ) : null}
            {item.verification_target ? (
              <Meta>验证:{item.verification_target}</Meta>
            ) : null}
          </>
        ) : tab === "attempts" ? (
          item.attempts.length > 0 ? (
            <ul className="dnode__attempts">
              {item.attempts.map((attempt) => (
                <li key={attempt.index} data-status={attempt.status}>
                  #{attempt.index} {ATTEMPT_KIND_LABELS[attempt.kind]} ·{" "}
                  {attempt.model}
                  {attempt.upgraded ? (
                    <em className="dnode__upgraded">已升级模型</em>
                  ) : null}{" "}
                  ·{" "}
                  {attempt.status === "running"
                    ? "进行中"
                    : attempt.status === "completed"
                      ? "完成"
                      : "失败"}
                  {attempt.summary ? ` — ${attempt.summary}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <Meta>尚无 Agent 尝试。</Meta>
          )
        ) : (
          <>
            {item.conflict_resolution ? (
              <p className="dnode__text dnode__text--merge">
                冲突解决:{item.conflict_resolution}
              </p>
            ) : null}
            {item.artifact_summary ? (
              <Meta>产物:{item.artifact_summary}</Meta>
            ) : (
              <Meta>尚无产物。</Meta>
            )}
          </>
        )}
      </div>
    </DNode>
  );
});

/* ── Diff（合并结果预览：等宽字体，+绿/-红） ── */

export const DiffNode = memo(function DiffNode({ data }: NodeProps) {
  const { terminalItems } = data as { run: Run; terminalItems: WorkItem[] };
  const ready =
    terminalItems.length > 0 &&
    terminalItems.every((item) => item.status === "completed");
  return (
    <DNode
      icon="diff"
      label="Integration Diff"
      chip={ready ? "候选完成" : "未开始"}
      chipTone={ready ? "green" : "gray"}
      width={420}
      ariaLabel="合并结果 Diff 预览"
    >
      {ready ? (
        <DiffView diff={DEMO_MERGE_DIFF} ariaLabel="Diff 内容" />
      ) : (
        <Meta>全部终端任务完成后生成 integration 候选 Diff。</Meta>
      )}
    </DNode>
  );
});

/* ── 验证（FE-QUAL-001：基线 vs 最终并列，独立 verdict） ── */

const VERDICT_LABELS = {
  clean: "clean",
  baseline_issues_only: "仅基线失败",
  new_regression: "新增回归",
  unavailable: "不可用",
} as const;

export const ValidationNode = memo(function ValidationNode({
  data,
}: NodeProps) {
  const { run, validation } = data as {
    run: Run;
    validation: RunValidation | null;
  };
  return (
    <DNode
      icon="validation"
      label="验证"
      chip={validation ? VERDICT_LABELS[validation.overall] : "未开始"}
      chipTone={validation ? TONE_BY_VERDICT[validation.overall] : "gray"}
      width={360}
      ariaLabel="验证节点：基线与最终对比"
    >
      {!validation ? (
        <Meta>到达 validating 阶段后并列显示基线与最终结果。</Meta>
      ) : (
        <ul className="dnode__validations">
          {validation.entries.map((entry) => (
            <li key={entry.command} data-verdict={entry.verdict}>
              <code className="dnode__tag">{entry.command}</code>
              <span className="dnode__validation-results">
                <span>
                  基线:{" "}
                  {entry.baseline
                    ? `退出 ${entry.baseline.exit_code} · ${entry.baseline.summary}`
                    : "无"}
                </span>
                <span>
                  最终:{" "}
                  {entry.final
                    ? `退出 ${entry.final.exit_code} · ${entry.final.summary}`
                    : "待运行"}
                </span>
              </span>
              <em
                className="dnode__chip"
                data-tone={TONE_BY_VERDICT[entry.verdict]}
              >
                {VERDICT_LABELS[entry.verdict]}
              </em>
            </li>
          ))}
        </ul>
      )}
      <Meta>
        历史失败显著展示但允许继续；只有新增/恶化失败机械阻断（PRD-QUAL-004）。
        {run.phase === "validating" ? "验证进行中…" : ""}
      </Meta>
    </DNode>
  );
});

/* ── 审核（FE-QUAL-002/003：三角度、P0/P1 阻断、unavailable 强制确认） ── */

const ANGLE_LABELS = {
  correctness: "correctness 正确性",
  quality: "quality 质量",
  security: "security 安全",
} as const;

const REVIEW_VERDICT_LABELS = {
  approved: "通过",
  approved_with_advisories: "通过（含建议）",
  blocking_findings: "阻断",
  unavailable: "不可用",
} as const;

export const ReviewNode = memo(function ReviewNode({ data }: NodeProps) {
  const { run, review } = data as { run: Run; review: RunReview | null };
  const forceDeliveryMutation = useMutation({
    mutationFn: () =>
      getApi().requestAction({
        kind: "force_deliver_unreviewed",
        run_id: run.id,
      }),
  });
  const forceDeliverable =
    run.phase === "blocked" && review?.overall === "unavailable";
  return (
    <DNode
      icon="review"
      label="审核"
      chip={review ? REVIEW_VERDICT_LABELS[review.overall] : "未开始"}
      chipTone={review ? TONE_BY_VERDICT[review.overall] : "gray"}
      width={360}
      ariaLabel="审核节点：三角度结论"
      actions={
        forceDeliverable ? (
          <PixelButton
            size="sm"
            tone="red"
            variant="outline"
            disabled={forceDeliveryMutation.isPending}
            onClick={() => forceDeliveryMutation.mutate()}
          >
            未经审核交付…
          </PixelButton>
        ) : null
      }
    >
      {!review ? (
        <Meta>到达 reviewing 阶段后按角度独立呈现（输入隔离）。</Meta>
      ) : (
        <ul className="dnode__angles">
          {review.angles.map((angle) => (
            <li key={angle.angle}>
              <header className="dnode__angle-head">
                <strong>{ANGLE_LABELS[angle.angle]}</strong>
                <em
                  className="dnode__chip"
                  data-tone={TONE_BY_VERDICT[angle.verdict]}
                >
                  {REVIEW_VERDICT_LABELS[angle.verdict]} · 第 {angle.rounds} 轮
                </em>
              </header>
              <Meta>输入:{angle.input_scope}</Meta>
              {angle.findings.length > 0 ? (
                <ul className="dnode__findings">
                  {angle.findings.map((finding) => (
                    <li
                      key={finding.id}
                      data-resolved={finding.resolved || undefined}
                      data-blocking={
                        finding.priority === "P0" || finding.priority === "P1"
                          ? true
                          : undefined
                      }
                    >
                      <code className="dnode__tag">{finding.priority}</code>{" "}
                      {finding.title}
                      {finding.resolved ? "（已修复）" : ""}
                      <br />
                      <i>{finding.detail}</i>
                    </li>
                  ))}
                </ul>
              ) : (
                <Meta>无发现。</Meta>
              )}
            </li>
          ))}
        </ul>
      )}
      <Meta>
        P0/P1 阻断、P2/P3 作为建议交付后仍可见；修复后只复查受影响角度。
      </Meta>
    </DNode>
  );
});

/* ── 发布（FE-PUB-001/002/004） ── */

const PUBLICATION_STATE_LABELS: Record<Publication["state"], string> = {
  not_started: "未开始",
  preparing: "准备中",
  pushed: "已推送",
  review_open: "PR/MR 已创建",
  waiting_remote: "等待远端检查",
  merged: "已合并",
  syncing_local: "同步本地",
  completed: "完成",
  failed: "失败",
};

export const PublicationNode = memo(function PublicationNode({
  data,
}: NodeProps) {
  const { run, publication } = data as {
    run: Run;
    publication: Publication | null;
  };
  const retryPublicationMutation = useMutation({
    mutationFn: () =>
      getApi().requestAction({
        kind: "publication_retry",
        run_id: run.id,
      }),
  });
  const retryable = run.phase === "blocked" && publication?.state === "failed";
  if (!publication) {
    return (
      <DNode
        icon="publish"
        label="发布"
        chip="未开始"
        chipTone="gray"
        width={360}
        ariaLabel="发布节点：未开始"
      >
        <Meta>验证与审核通过后按 Run 冻结路径发布。</Meta>
      </DNode>
    );
  }
  return (
    <DNode
      icon="publish"
      label="发布"
      chip={PUBLICATION_STATE_LABELS[publication.state]}
      chipTone={
        publication.state === "completed"
          ? "green"
          : publication.state === "failed"
            ? "red"
            : publication.state === "not_started"
              ? "gray"
              : "cyan"
      }
      width={360}
      ariaLabel="发布节点"
      actions={
        retryable ? (
          <PixelButton
            size="sm"
            tone="cyan"
            variant="outline"
            disabled={retryPublicationMutation.isPending}
            onClick={() => retryPublicationMutation.mutate()}
          >
            重试发布（prepare/confirm）…
          </PixelButton>
        ) : null
      }
    >
      <Meta>路径:{PATH_LABELS[publication.path]}（Run 开始前冻结）</Meta>
      <Meta>{publication.frozen_reason}</Meta>
      <Meta>
        分支: <code className="dnode__tag">{publication.branch}</code>
        {publication.commit ? (
          <>
            {" "}
            提交: <code className="dnode__tag">{publication.commit}</code>
          </>
        ) : null}
      </Meta>
      {publication.pr_url ? (
        <Meta>
          PR/MR: <code className="dnode__tag">{publication.pr_url}</code>
        </Meta>
      ) : null}
      {publication.ci_fix_attempts > 0 ? (
        <Meta>
          远端 CI 修复推送 {publication.ci_fix_attempts}/1 次（PRD-PUB-007）。
        </Meta>
      ) : null}
      {publication.state === "completed" ? (
        <p className="dnode__text">
          {publication.remote_merged && !publication.local_synced
            ? "远端已交付 · 本地待同步（PRD-PUB-006）"
            : publication.path === "local"
              ? "已交付本地主分支（本地回退路径可见，质量门槛未降低）"
              : "远端已合并 · 本地已同步"}
        </p>
      ) : null}
      {publication.blocked_reason ? (
        <p className="dnode__warning" role="alert">
          {publication.blocked_reason}
        </p>
      ) : null}
    </DNode>
  );
});

/* ── 诊断（P2 简版：事实摘要 + 失败原因 + 恢复建议） ── */

export const DiagnosticsNode = memo(function DiagnosticsNode({
  data,
}: NodeProps) {
  const { run, requirement } = data as {
    run: Run;
    requirement: Requirement;
  };
  const actions = useDomainStore((state) => state.actions);
  const runActions = Object.values(actions).filter(
    (action) => action.run_id === run.id,
  );
  const recovery = (() => {
    if (run.phase === "blocked") {
      return "重试将重置相关修复上限继续；放弃（确认链）转入终态并保留现场事实。";
    }
    if (run.phase === "waiting_workspace") {
      return "提交或清理主工作区修改后自动继续；系统不 stash、不覆盖。";
    }
    if (run.phase === "paused") {
      return "编辑 pending 工作项、依赖与验证目标后恢复。";
    }
    if (run.outcome === "cancelled") {
      return "Run 已取消：现场事实与取消原因保留，可重新确认规格生成新 Run。";
    }
    return "无需介入：Run 由后端状态机自动推进。";
  })();
  return (
    <DNode icon="diag" label="诊断" width={420} ariaLabel="诊断节点">
      <Meta>
        Run {run.id} · 需求 {requirement.id} · 规格 r{run.requirement_revision}
      </Meta>
      <Meta>
        阶段:{RUN_PHASE_LABELS[run.phase]}
        {run.resume_phase
          ? `（恢复原阶段:${RUN_PHASE_LABELS[run.resume_phase]}）`
          : ""}
        {run.outcome ? ` · 结果:${run.outcome}` : ""}
      </Meta>
      {run.blocked_reason ? (
        <p className="dnode__warning">失败原因:{run.blocked_reason}</p>
      ) : null}
      {run.cancel_reason ? <Meta>取消原因:{run.cancel_reason}</Meta> : null}
      {runActions.length > 0 ? (
        <ul className="dnode__lines">
          {runActions.map((action) => (
            <li key={action.id}>
              操作:{action.title} ·{" "}
              {action.state === "awaiting"
                ? "等待确认"
                : action.state === "confirmed"
                  ? "已确认"
                  : "已取消"}
              {action.result ? ` — ${action.result.message}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <Meta>恢复建议:{recovery}</Meta>
    </DNode>
  );
});

/* ── 危险操作确认 / 结果（FE-CANVAS-019、PRD-CANVAS-008） ── */

export const ActionConfirmationNode = memo(function ActionConfirmationNode({
  data,
}: NodeProps) {
  const { action } = data as { action: PendingAction };
  const confirmMutation = useMutation({
    mutationFn: () => getApi().confirmAction(action.id),
  });
  const cancelMutation = useMutation({
    mutationFn: () => getApi().cancelAction(action.id),
  });
  const pending = confirmMutation.isPending || cancelMutation.isPending;
  return (
    <DNode
      icon="action"
      label="操作确认"
      chip={action.irreversible ? "不可逆" : "两阶段"}
      chipTone="red"
      width={340}
      ariaLabel={`危险操作确认:${action.title}`}
      className="dnode--danger"
      actions={
        <>
          <PixelButton
            size="sm"
            tone="red"
            disabled={pending}
            onClick={() => confirmMutation.mutate()}
          >
            确认执行
          </PixelButton>
          <PixelButton
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => cancelMutation.mutate()}
          >
            取消
          </PixelButton>
        </>
      }
    >
      <p className="dnode__text">
        <strong>{action.title}</strong>
      </p>
      <p className="dnode__text">{action.impact}</p>
      <Meta>目标 Run:{action.run_id}</Meta>
    </DNode>
  );
});

export const ActionResultNode = memo(function ActionResultNode({
  data,
}: NodeProps) {
  const { action } = data as { action: PendingAction };
  return (
    <DNode
      icon="result"
      label="操作结果"
      chip={action.state === "confirmed" ? "已确认" : "已取消"}
      chipTone={action.state === "confirmed" ? "green" : "gray"}
      width={340}
      ariaLabel={`操作结果:${action.title}`}
    >
      <p className="dnode__text">
        <strong>{action.title}</strong>
      </p>
      <p className="dnode__text">{action.result?.message}</p>
      {action.irreversible && action.state === "confirmed" ? (
        <Meta>该确认是永久事实，进入事件日志与快照。</Meta>
      ) : null}
    </DNode>
  );
});
