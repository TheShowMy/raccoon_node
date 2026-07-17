import { PixelButton, PixelTextarea } from "@pxlkit/ui-kit";
import type { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getApi } from "../../api";
import {
  groupRequirements,
  REQUIREMENT_GROUP_ORDER,
  type RequirementGroupKey,
} from "../../api/groups";
import { DEMO_MERGE_DIFF } from "../../api/mock/demoContent";
import { qualitySummary, RUN_PHASE_LABELS } from "../../api/quality";
import type {
  AcceptanceScenario,
  ClarificationRound,
  PendingAction,
  Publication,
  Requirement,
  RequirementRevision,
  RequirementSpec,
  Run,
  RunReview,
  RunValidation,
  SpecConstraint,
  WorkItem,
  WorkPlan,
} from "../../api/types";
import { ancestorChain } from "../../chat/dag";
import { DiffView } from "../../components/DiffView";
import { DNode } from "../../components/DNode";
import { useCanvasStore } from "../../store/canvasStore";
import { useDeliveryStore } from "../../store/deliveryStore";
import { useDomainStore } from "../../store/domainStore";

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

function Meta({ children }: { children: React.ReactNode }) {
  return <p className="dnode__meta">{children}</p>;
}

/* ── 需求列表（空间锚点，FE-DELIVERY-002） ── */

const REQUIREMENT_STATE_LABELS: Record<Requirement["state"], string> = {
  drafting: "草拟中",
  clarifying: "澄清中",
  spec_ready: "待确认",
  confirmed: "已确认",
  queued: "排队中",
  cancelled: "已取消",
  superseded: "被取代",
};

function RequirementListInner() {
  const requirements = useDomainStore((state) => state.requirements);
  const runs = useDomainStore((state) => state.runs);
  const validations = useDomainStore((state) => state.validations);
  const reviews = useDomainStore((state) => state.reviews);
  const selectedId = useDeliveryStore((state) => state.selectedRequirementId);
  const search = useDeliveryStore((state) => state.search);
  const groupFilter = useDeliveryStore((state) => state.groupFilter);

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
    void useDomainStore.getState().reorderQueue(ids);
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
              {groups.find((group) => group.key === key)?.label ?? key}
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
                {group.label}（{group.items.length}）
              </h4>
              <ul className="req-list__items">
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
                          {REQUIREMENT_STATE_LABELS[requirement.state]}
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
                            disabled={index === 0}
                            onClick={() => move(group.key, index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`下移 ${requirement.title}`}
                            disabled={index === group.items.length - 1}
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
      <Meta>活动项（含 waiting_workspace）不可移动（PRD-RUN-001）。</Meta>
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

/* ── 来源对话（FE-DELIVERY-003） ── */

export const SourceRefNode = memo(function SourceRefNode({ data }: NodeProps) {
  const { requirement } = data as { requirement: Requirement };
  const navigate = useNavigate();
  const conversation = useDomainStore((state) => state.conversation);
  const firstSource = requirement.source_node_ids
    .map((id) => conversation.nodes[id])
    .find(Boolean);
  const locateConversation = () => {
    if (!firstSource) return;
    const canvas = useCanvasStore.getState();
    const branchId =
      requirement.source_branch_id ?? conversation.root_branch_id;
    canvas.setActiveConversationBranch(branchId);
    canvas.setSelectedConversationNode(firstSource.id);
    const position = conversation.positions[firstSource.id];
    if (position) {
      canvas.setConversationViewport(branchId, {
        zoom: 1,
        x: 160 - position.x,
        y: 140 - position.y,
      });
    }
    navigate("/");
  };
  return (
    <DNode icon="source" label="来源对话" width={280} ariaLabel="来源对话节点">
      <Meta>分支 {requirement.source_branch_id}</Meta>
      <p className="dnode__quote">
        {firstSource
          ? ancestorChain(conversation, firstSource.id)
              .filter((node) => node.kind === "user_message")
              .at(-1)
              ?.content.slice(0, 80) || firstSource.content.slice(0, 80)
          : "来源节点已归档"}
      </p>
      <div className="dnode__actions">
        <PixelButton size="sm" variant="outline" onClick={locateConversation}>
          定位对话节点
        </PixelButton>
      </div>
    </DNode>
  );
});

/* ── 澄清（FE-SPEC-001：一次一个问题，选项 + 自定义输入） ── */

export const ClarificationNode = memo(function ClarificationNode({
  data,
}: NodeProps) {
  const { round } = data as { round: ClarificationRound };
  const [custom, setCustom] = useState("");
  const pending = round.state === "pending";
  const submit = (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed || !pending) return;
    void useDomainStore.getState().answerClarification({
      requirement_id: round.requirement_id,
      round_id: round.id,
      answer: trimmed,
    });
    setCustom("");
  };
  return (
    <DNode
      icon="clarify"
      label="澄清"
      chip={pending ? "待回答" : "已回答"}
      chipTone={pending ? "yellow" : "green"}
      width={340}
      ariaLabel="澄清问题节点"
    >
      <p className="dnode__text">{round.question}</p>
      {pending ? (
        <div className="nodrag nowheel">
          <div className="dnode__chips" role="group" aria-label="推荐选项">
            {round.options.map((option) => (
              <button
                key={option}
                type="button"
                className="dnode__option"
                onClick={() => submit(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="dnode__inline-form">
            <PixelTextarea
              aria-label="自定义回答"
              placeholder="自定义回答…"
              rows={2}
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
            />
            <PixelButton
              size="sm"
              tone="cyan"
              disabled={!custom.trim()}
              onClick={() => submit(custom)}
            >
              提交回答
            </PixelButton>
          </div>
        </div>
      ) : (
        <p className="dnode__answer">回答：{round.answer}</p>
      )}
    </DNode>
  );
});

/* ── 规格（FE-SPEC-002/003/004：分区 + 稳定 ID + 来源 + revision 链） ── */

const LIST_FIELDS = [
  { key: "in_scope", label: "范围内" },
  { key: "out_of_scope", label: "范围外" },
  { key: "non_goals", label: "非目标" },
  { key: "risks", label: "风险" },
  { key: "assumptions", label: "假设" },
  { key: "evidence", label: "证据（修改不触发确认撤销）" },
] as const satisfies readonly { key: keyof RequirementSpec; label: string }[];

function LinesView({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <Meta>无</Meta>;
  return (
    <ul className="dnode__lines">
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ul>
  );
}

function LinesEditor({
  value,
  ariaLabel,
  onChange,
}: {
  value: string[];
  ariaLabel: string;
  onChange: (lines: string[]) => void;
}) {
  return (
    <textarea
      className="dnode__textarea"
      aria-label={ariaLabel}
      rows={Math.max(2, value.length)}
      value={value.join("\n")}
      onChange={(event) => onChange(event.target.value.split("\n"))}
    />
  );
}

function ScenarioView({ scenario }: { scenario: AcceptanceScenario }) {
  return (
    <li className="dnode__scenario">
      <code className="dnode__tag">{scenario.id}</code>
      <span>
        <b>Given</b> {scenario.given}
        <br />
        <b>When</b> {scenario.when}
        <br />
        <b>Then</b> {scenario.then}
      </span>
    </li>
  );
}

function ConstraintView({ constraint }: { constraint: SpecConstraint }) {
  return (
    <li className="dnode__scenario">
      <code className="dnode__tag">{constraint.id}</code>
      <span>
        {constraint.text}
        <br />
        <i className="dnode__source">
          来源：
          {constraint.source.kind === "user_message"
            ? "用户消息"
            : "仓库事实"}{" "}
          · {constraint.source.ref}
        </i>
      </span>
    </li>
  );
}

function SpecSections({
  spec,
  draft,
  setDraft,
}: {
  spec: RequirementSpec;
  draft: RequirementSpec | null;
  setDraft: (spec: RequirementSpec) => void;
}) {
  const editing = draft !== null;
  const patch = (partial: Partial<RequirementSpec>) => {
    if (draft) setDraft({ ...draft, ...partial });
  };
  return (
    <div className="dnode__sections nodrag nowheel">
      <section>
        <h5>目标</h5>
        {editing ? (
          <textarea
            className="dnode__textarea"
            aria-label="目标"
            rows={2}
            value={draft.goal}
            onChange={(event) => patch({ goal: event.target.value })}
          />
        ) : (
          <p className="dnode__text">{spec.goal}</p>
        )}
      </section>
      <section>
        <h5>用户价值</h5>
        {editing ? (
          <textarea
            className="dnode__textarea"
            aria-label="用户价值"
            rows={2}
            value={draft.user_value}
            onChange={(event) => patch({ user_value: event.target.value })}
          />
        ) : (
          <p className="dnode__text">{spec.user_value}</p>
        )}
      </section>
      {LIST_FIELDS.map(({ key, label }) => (
        <section key={key}>
          <h5>{label}</h5>
          {editing ? (
            <LinesEditor
              ariaLabel={label}
              value={draft[key] as string[]}
              onChange={(lines) =>
                patch({ [key]: lines } as Partial<RequirementSpec>)
              }
            />
          ) : (
            <LinesView lines={spec[key] as string[]} />
          )}
        </section>
      ))}
      <section>
        <h5>验收场景（Given/When/Then · 稳定 ID）</h5>
        {editing ? (
          <ul className="dnode__lines">
            {draft.scenarios.map((scenario, index) => (
              <li key={scenario.id} className="dnode__scenario-edit">
                <code className="dnode__tag">{scenario.id}</code>
                {(["given", "when", "then"] as const).map((field) => (
                  <input
                    key={field}
                    className="dnode__input"
                    aria-label={`${scenario.id} ${field}`}
                    placeholder={field}
                    value={scenario[field]}
                    onChange={(event) =>
                      patch({
                        scenarios: draft.scenarios.map((entry, i) =>
                          i === index
                            ? { ...entry, [field]: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  />
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="dnode__lines">
            {spec.scenarios.map((scenario) => (
              <ScenarioView key={scenario.id} scenario={scenario} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <h5>约束（含来源）</h5>
        <ul className="dnode__lines">
          {(editing ? draft.constraints : spec.constraints).map(
            (constraint, index) =>
              editing ? (
                <li key={constraint.id} className="dnode__scenario-edit">
                  <code className="dnode__tag">{constraint.id}</code>
                  <input
                    className="dnode__input"
                    aria-label={`${constraint.id} 约束`}
                    value={constraint.text}
                    onChange={(event) =>
                      patch({
                        constraints: draft.constraints.map((entry, i) =>
                          i === index
                            ? { ...entry, text: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  />
                  <i className="dnode__source">来源：{constraint.source.ref}</i>
                </li>
              ) : (
                <ConstraintView key={constraint.id} constraint={constraint} />
              ),
          )}
        </ul>
      </section>
    </div>
  );
}

export const SpecNode = memo(function SpecNode({ data }: NodeProps) {
  const { requirement, revisions } = data as {
    requirement: Requirement;
    revisions: RequirementRevision[];
  };
  const latest = revisions.at(-1)!;
  const [viewRevision, setViewRevision] = useState(latest.revision);
  const [draft, setDraft] = useState<RequirementSpec | null>(null);
  const [conflict, setConflict] = useState(false);
  const viewing =
    revisions.find((entry) => entry.revision === viewRevision) ?? latest;
  const isLatest = viewing.revision === latest.revision;

  const save = async () => {
    if (!draft) return;
    const result = await useDomainStore.getState().updateSpec({
      requirement_id: requirement.id,
      base_revision: viewing.revision,
      spec: draft,
    });
    if (result.conflict) {
      // FE-SPEC-004：冲突——服务器版本已更新，保留本地草稿由用户对照
      setConflict(true);
      return;
    }
    setConflict(false);
    setDraft(null);
    setViewRevision(result.revision);
  };

  return (
    <DNode
      icon="spec"
      label="规格"
      chip={`r${viewing.revision} · ${viewing.semantic_hash.slice(0, 6)}`}
      chipTone={isLatest ? "cyan" : "gray"}
      width={420}
      ariaLabel={`规格节点 revision ${viewing.revision}`}
      actions={
        <>
          <div
            className="dnode__rev-tabs"
            role="group"
            aria-label="revision 链"
          >
            {revisions.map((entry) => (
              <button
                key={entry.revision}
                type="button"
                data-active={entry.revision === viewing.revision || undefined}
                disabled={draft !== null}
                onClick={() => setViewRevision(entry.revision)}
              >
                r{entry.revision}
              </button>
            ))}
          </div>
          {draft ? (
            <span className="dnode__chips">
              <PixelButton size="sm" tone="green" onClick={() => void save()}>
                保存为新 revision
              </PixelButton>
              <PixelButton
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(null);
                  setConflict(false);
                }}
              >
                放弃
              </PixelButton>
            </span>
          ) : (
            <PixelButton
              size="sm"
              variant="outline"
              disabled={!isLatest}
              onClick={() => setDraft(structuredClone(viewing.spec))}
            >
              编辑
            </PixelButton>
          )}
        </>
      }
    >
      {conflict ? (
        <p className="dnode__warning" role="alert">
          revision 已过期：服务器已有更新版本，请对照后重新编辑。
        </p>
      ) : null}
      {requirement.confirmed_revision !== null && isLatest ? (
        <Meta>
          语义修改将撤销确认并取消未终态 Run；仅证据修改不触发（PRD-SPEC-007）。
        </Meta>
      ) : null}
      <SpecSections
        spec={viewing.spec}
        draft={draft}
        setDraft={(spec) => setDraft(spec)}
      />
    </DNode>
  );
});

/* ── 确认（FE-SPEC-005：发布路径/模型角色/软阈值/脏工作区，无计划确认） ── */

const PATH_LABELS = {
  local: "本地主分支 fast-forward",
  github_pull_request: "GitHub PR",
  gitlab_merge_request: "GitLab MR",
} as const;

export const ConfirmationNode = memo(function ConfirmationNode({
  data,
}: NodeProps) {
  const { requirement, revisions } = data as {
    requirement: Requirement;
    revisions: RequirementRevision[];
  };
  const [conflict, setConflict] = useState(false);
  const confirmedRevision = revisions.find(
    (entry) => entry.revision === requirement.confirmed_revision,
  );
  const ready = requirement.state === "spec_ready";
  const { data: preview } = useQuery({
    queryKey: [
      "confirmation-preview",
      requirement.id,
      requirement.latest_revision,
    ],
    queryFn: () => getApi().getConfirmationPreview(requirement.id),
    enabled: ready,
  });

  const confirm = async () => {
    const result = await useDomainStore.getState().confirmRequirement({
      requirement_id: requirement.id,
      revision: requirement.latest_revision,
    });
    setConflict(result.conflict);
  };

  return (
    <DNode
      icon="confirm"
      label="确认"
      chip={
        confirmedRevision
          ? `已确认 r${requirement.confirmed_revision}`
          : ready
            ? "待确认"
            : "—"
      }
      chipTone={confirmedRevision ? "green" : ready ? "yellow" : "gray"}
      width={340}
      ariaLabel="规格确认节点"
      actions={
        ready ? (
          <PixelButton size="sm" tone="green" onClick={() => void confirm()}>
            确认 r{requirement.latest_revision} 并入队
          </PixelButton>
        ) : null
      }
    >
      {confirmedRevision?.confirmation ? (
        <Meta>
          确认事实：r{confirmedRevision.revision} ·{" "}
          {confirmedRevision.confirmation.confirmed_at.slice(0, 19)}；
          确认后自动生成 WorkPlan 并启动 Run（无计划确认步骤）。
        </Meta>
      ) : null}
      {ready && preview ? (
        <div className="dnode__sections">
          <Meta>预计发布路径：{PATH_LABELS[preview.publication_path]}</Meta>
          <Meta>{preview.publication_reason}</Meta>
          <Meta>
            模型角色：
            {preview.model_roles
              .map((entry) => `${entry.role}=${entry.model}`)
              .join(" · ")}
          </Meta>
          <Meta>软阈值：{preview.soft_threshold}</Meta>
          {preview.workspace_note ? (
            <p className="dnode__warning">{preview.workspace_note}</p>
          ) : null}
          {conflict ? (
            <p className="dnode__warning" role="alert">
              确认冲突：规格已有新 revision，请确认最新版本。
            </p>
          ) : null}
        </div>
      ) : null}
      {!ready && !confirmedRevision ? <Meta>规格就绪后可确认。</Meta> : null}
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
  const { run, requirement, validation, review } = data as {
    run: Run;
    requirement: Requirement;
    validation: RunValidation | null;
    review: RunReview | null;
  };
  const domain = useDomainStore.getState();
  const railIndex = RUN_RAIL.includes(run.phase)
    ? RUN_RAIL.indexOf(run.phase)
    : run.resume_phase
      ? RUN_RAIL.indexOf(run.resume_phase)
      : 0;
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
          {run.phase === "executing" ? (
            <PixelButton
              size="sm"
              variant="outline"
              onClick={() => void domain.pauseRun(run.id)}
            >
              请求暂停
            </PixelButton>
          ) : null}
          {run.phase === "paused" ? (
            <PixelButton
              size="sm"
              tone="cyan"
              onClick={() => void domain.resumeRun(run.id)}
            >
              恢复
            </PixelButton>
          ) : null}
          {run.phase === "blocked" ? (
            <>
              <PixelButton
                size="sm"
                tone="cyan"
                onClick={() => void domain.retryRun(run.id)}
              >
                重试
              </PixelButton>
              <PixelButton
                size="sm"
                tone="red"
                variant="outline"
                onClick={() =>
                  void domain.requestAction({
                    kind: "abandon_run",
                    run_id: run.id,
                  })
                }
              >
                放弃…
              </PixelButton>
            </>
          ) : null}
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
  const { item, runPhase, runId } = data as {
    item: WorkItem;
    runPhase: Run["phase"];
    runId: string;
  };
  const editable = runPhase === "paused" && item.status === "pending";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [scenarios, setScenarios] = useState(item.scenario_ids.join(","));
  const [target, setTarget] = useState(item.verification_target);
  const save = async () => {
    await useDomainStore.getState().updateWorkItem({
      run_id: runId,
      item_id: item.id,
      patch: {
        title,
        scenario_ids: scenarios
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        verification_target: target,
      },
    });
    setEditing(false);
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
          <span className="dnode__chips">
            <PixelButton size="sm" tone="green" onClick={() => void save()}>
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
        </div>
      ) : (
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
      )}
      {item.attempts.length > 0 ? (
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
      ) : null}
      {item.conflict_resolution ? (
        <p className="dnode__text dnode__text--merge">
          冲突解决:{item.conflict_resolution}
        </p>
      ) : null}
      {item.artifact_summary ? <Meta>产物:{item.artifact_summary}</Meta> : null}
    </DNode>
  );
});

/* ── Diff（合并结果预览：等宽字体，+绿/-红） ── */

export const DiffNode = memo(function DiffNode({ data }: NodeProps) {
  const { mergeTask } = data as { run: Run; mergeTask: WorkItem };
  return (
    <DNode
      icon="diff"
      label="合并 Diff"
      chip={mergeTask.status === "completed" ? "已合并" : "待合并"}
      chipTone={mergeTask.status === "completed" ? "green" : "gray"}
      width={420}
      ariaLabel="合并结果 Diff 预览"
    >
      {/* 假数据层的演示 Diff；后端阶段由 artifact 引用替换 */}
      <DiffView diff={DEMO_MERGE_DIFF} ariaLabel="Diff 内容" />
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
  const domain = useDomainStore.getState();
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
            onClick={() =>
              void domain.requestAction({
                kind: "force_deliver_unreviewed",
                run_id: run.id,
              })
            }
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
    publication: Publication;
  };
  const domain = useDomainStore.getState();
  const retryable = run.phase === "blocked" && publication.state === "failed";
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
            onClick={() =>
              void domain.requestAction({
                kind: "publication_retry",
                run_id: run.id,
              })
            }
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
  const domain = useDomainStore.getState();
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
            onClick={() => void domain.confirmAction(action.id)}
          >
            确认执行
          </PixelButton>
          <PixelButton
            size="sm"
            variant="outline"
            onClick={() => void domain.cancelAction(action.id)}
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
