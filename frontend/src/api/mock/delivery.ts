import type {
  ConfirmationPreview,
  ScenarioCommand,
  ScenarioState,
} from "../client";
import { semanticHash } from "../specHash";
import type {
  Attempt,
  ClarificationRound,
  DomainEventPayload,
  EventAggregateType,
  EventType,
  NotificationSeverity,
  NotificationSourceWorkbench,
  PendingAction,
  PendingActionKind,
  Publication,
  Requirement,
  RequirementRevision,
  RequirementSpec,
  ReviewVerdict,
  Run,
  RunReview,
  RunValidation,
  ValidationEntry,
  VerificationVerdict,
  WorkItem,
  WorkPlan,
} from "../types";
import { validateWorkPlan } from "../workplan";
import { qualitySummary } from "../quality";
import {
  buildDemoPlan,
  DEMO_BRANCH,
  DEMO_COMMIT,
  DEMO_MODEL_ROLES,
  DEMO_PR_URL,
  DEMO_SOFT_THRESHOLD,
  demoReviewAngles,
  demoSpec,
  demoValidationEntries,
  frozenReason,
} from "./demoContent";
import { DemoDirector, RunCancelled } from "./director";

type Emit = <T extends EventType>(
  aggregateType: EventAggregateType,
  aggregateId: string,
  eventType: T,
  payload: DomainEventPayload[T],
) => void;

type Notify = (
  severity: NotificationSeverity,
  message: string,
  sourceWorkbench: NotificationSourceWorkbench,
  sourceNodeId: string | null,
) => string;

const now = () => new Date().toISOString();

const GRAPH_ID = "g-main";

/** 演示澄清问题（PRD-SPEC-004：一次一个关键问题，推荐选项 + 自定义输入） */
const DEMO_CLARIFICATION = {
  question: "这个需求主要影响哪部分行为？回答将决定验收场景的侧重。",
  options: ["工作流执行语义", "画布交互与展示", "两者都涉及"],
};

/**
 * 需求交付模块（假数据层）：需求生命周期、澄清、规格 revision、队列、
 * WorkPlan、Run 导演脚本、验证/审核/发布与危险操作确认链。
 * 所有状态变化先经 emit 写事件日志，再被前端投影（PRD-EVENT-002）。
 */
export class DeliveryModule {
  readonly director = new DemoDirector();

  private requirementCounter = 0;
  private roundCounter = 0;
  private runCounter = 0;
  private planCounter = 0;
  private actionCounter = 0;

  private readonly requirements = new Map<string, Requirement>();
  private readonly rounds = new Map<string, ClarificationRound>();
  private readonly revisions = new Map<string, RequirementRevision[]>();
  private readonly runs = new Map<string, Run>();
  private readonly plans = new Map<string, WorkPlan>();
  private readonly validations = new Map<string, RunValidation>();
  private readonly reviews = new Map<string, RunReview>();
  private readonly publications = new Map<string, Publication>();
  private readonly actions = new Map<string, PendingAction>();

  /** runId → 阻断通知 id（解除时发 notification.resolved，PRD-NOTIFY-007） */
  private readonly blockedNotifications = new Map<string, string>();
  private readonly pauseRequested = new Set<string>();

  constructor(
    private readonly deps: {
      idPrefix: string;
      emit: Emit;
      notify: Notify;
      resolveNotification: (notificationId: string) => void;
      nodeContent: (nodeId: string) => string | null;
      latency: () => Promise<void>;
    },
  ) {}

  private nextId(kind: "req" | "clr" | "run" | "plan" | "act"): string {
    const counters = {
      req: () => ++this.requirementCounter,
      clr: () => ++this.roundCounter,
      run: () => ++this.runCounter,
      plan: () => ++this.planCounter,
      act: () => ++this.actionCounter,
    } as const;
    return `${kind}-${this.deps.idPrefix}-${counters[kind]()}`;
  }

  /* ── 快照与概览 ── */

  snapshotState() {
    return {
      requirements: [...this.requirements.values()],
      clarifications: [...this.rounds.values()],
      revisions: [...this.revisions.values()].flat(),
      runs: [...this.runs.values()],
      plans: [...this.plans.values()],
      validations: [...this.validations.values()],
      reviews: [...this.reviews.values()],
      publications: [...this.publications.values()],
      actions: [...this.actions.values()],
    };
  }

  /** writer lease 投影（PRD-RUN-001）：活动 Run（含 waiting_workspace）持锁 */
  writeLockInfo(): { locked: boolean; owner_run_id: string | null } {
    const active = [...this.runs.values()].find(
      (run) => run.phase !== "terminal",
    );
    return active
      ? { locked: true, owner_run_id: active.id }
      : { locked: false, owner_run_id: null };
  }

  summaryLines(): string[] {
    const requirements = [...this.requirements.values()];
    const queued = requirements.filter(
      (requirement) =>
        requirement.state === "confirmed" || requirement.state === "queued",
    ).length;
    const active = [...this.runs.values()].filter(
      (run) => run.phase !== "terminal",
    );
    const pendingClarification = [...this.rounds.values()].filter(
      (round) => round.state === "pending",
    ).length;
    const lastDelivered = [...this.runs.values()]
      .filter((run) => run.outcome === "delivered")
      .at(-1);
    const conclusion = lastDelivered
      ? qualitySummary({
          run: lastDelivered,
          validation: this.validations.get(lastDelivered.id) ?? null,
          review: this.reviews.get(lastDelivered.id) ?? null,
        })
      : "暂无交付";
    return [
      `队列 ${queued} · 活动 Run ${active.length} · 待澄清 ${pendingClarification}`,
      `最近结论：${conclusion}`,
      active.length > 0
        ? `当前：${active.map((run) => `${run.id} ${run.phase}`).join("、")}`
        : "从对话「整理为需求」开始",
    ];
  }

  /* ── 需求与澄清 ── */

  async createRequirementFromChat(input: {
    branch_id: string;
    node_ids: string[];
    title?: string;
  }): Promise<{ requirement_id: string }> {
    await this.deps.latency();
    // 同一来源节点的未取消需求去重（change 自动创建 + 手动整理可能重复）
    const shared = new Set(input.node_ids);
    const existing = [...this.requirements.values()].find(
      (requirement) =>
        requirement.state !== "cancelled" &&
        requirement.state !== "superseded" &&
        requirement.source_node_ids.some((id) => shared.has(id)),
    );
    if (existing) return { requirement_id: existing.id };

    const sourceText = input.node_ids
      .map((id) => this.deps.nodeContent(id))
      .find((content) => content && content.trim().length > 0);
    const title =
      input.title ??
      (sourceText ? sourceText.trim().slice(0, 24) : "未命名需求");
    const requirement: Requirement = {
      id: this.nextId("req"),
      title,
      state: "clarifying",
      source_branch_id: input.branch_id,
      source_node_ids: input.node_ids,
      latest_revision: 0,
      confirmed_revision: null,
      queue_position: null,
      latest_run_id: null,
      created_at: now(),
    };
    this.requirements.set(requirement.id, requirement);
    this.deps.emit("requirement", requirement.id, "requirement.created", {
      requirement,
    });

    const round: ClarificationRound = {
      id: this.nextId("clr"),
      requirement_id: requirement.id,
      question: DEMO_CLARIFICATION.question,
      options: DEMO_CLARIFICATION.options,
      answer: null,
      state: "pending",
      asked_at: now(),
      answered_at: null,
    };
    this.rounds.set(round.id, round);
    this.deps.emit(
      "requirement",
      requirement.id,
      "requirement.clarification_asked",
      { round },
    );
    this.deps.notify(
      "info",
      `需求《${title}》已进入澄清：请在需求交付工作台回答 1 个关键问题。`,
      "delivery",
      requirement.id,
    );
    return { requirement_id: requirement.id };
  }

  async answerClarification(input: {
    requirement_id: string;
    round_id: string;
    answer: string;
  }): Promise<void> {
    await this.deps.latency();
    const round = this.rounds.get(input.round_id);
    const requirement = this.requirements.get(input.requirement_id);
    if (!round || !requirement || round.state !== "pending") return;
    const answered: ClarificationRound = {
      ...round,
      answer: input.answer,
      state: "answered",
      answered_at: now(),
    };
    this.rounds.set(round.id, answered);
    this.deps.emit(
      "requirement",
      requirement.id,
      "requirement.clarification_answered",
      { round: answered },
    );
    // 澄清完成 → 生成规格 revision 1（PRD-SPEC-001）
    const spec = demoSpec(requirement.title, input.answer);
    this.appendRevision(requirement, spec);
    this.patchRequirement(requirement.id, {
      state: "spec_ready",
      latest_revision: 1,
    });
  }

  private appendRevision(
    requirement: Requirement,
    spec: RequirementSpec,
  ): RequirementRevision {
    const revision: RequirementRevision = {
      requirement_id: requirement.id,
      revision: requirement.latest_revision + 1,
      spec,
      semantic_hash: semanticHash(spec),
      created_at: now(),
      source_graph_id: GRAPH_ID,
      source_branch_id: requirement.source_branch_id,
      source_node_ids: requirement.source_node_ids,
      confirmation: null,
    };
    const list = this.revisions.get(requirement.id) ?? [];
    list.push(revision);
    this.revisions.set(requirement.id, list);
    this.deps.emit(
      "requirement",
      requirement.id,
      "requirement.revision_created",
      { revision },
    );
    return revision;
  }

  private patchRequirement(id: string, patch: Partial<Requirement>) {
    const current = this.requirements.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.requirements.set(id, next);
    this.deps.emit("requirement", id, "requirement.updated", {
      requirement: next,
    });
  }

  /* ── 规格编辑与确认 ── */

  async updateSpec(input: {
    requirement_id: string;
    base_revision: number;
    spec: RequirementSpec;
  }): Promise<{ revision: number; conflict: boolean }> {
    await this.deps.latency();
    const requirement = this.requirements.get(input.requirement_id);
    if (!requirement) return { revision: 0, conflict: true };
    // optimistic revision：过期基座返回冲突（BE-SPEC-002）
    if (input.base_revision !== requirement.latest_revision) {
      return { revision: requirement.latest_revision, conflict: true };
    }
    const previous = this.revisions.get(input.requirement_id)?.at(-1);
    const semanticChanged =
      previous !== undefined &&
      requirement.confirmed_revision !== null &&
      semanticHash(previous.spec) !== semanticHash(input.spec);
    const revision = this.appendRevision(requirement, input.spec);
    this.patchRequirement(requirement.id, {
      latest_revision: revision.revision,
    });
    if (semanticChanged) {
      // PRD-SPEC-007：语义修改撤销确认、取消未终态 Run、需求回 spec_ready
      this.patchRequirement(requirement.id, {
        state: "spec_ready",
        confirmed_revision: null,
        queue_position: null,
      });
      const activeRun = requirement.latest_run_id
        ? this.runs.get(requirement.latest_run_id)
        : undefined;
      if (activeRun && activeRun.phase !== "terminal") {
        this.director.requestCancel(
          activeRun.id,
          "规格发生语义修改，确认已撤销（PRD-SPEC-007）",
        );
      }
      this.deps.notify(
        "warning",
        `需求《${requirement.title}》规格发生语义修改：确认已撤销，关联 Run 已取消，请重新确认。`,
        "delivery",
        requirement.id,
      );
    }
    return { revision: revision.revision, conflict: false };
  }

  async getConfirmationPreview(
    requirement_id: string,
  ): Promise<ConfirmationPreview> {
    await this.deps.latency();
    const requirement = this.requirements.get(requirement_id);
    const remoteReady = this.director.flag("remote_ready");
    const dirty = this.director.flag("dirty_workspace");
    return {
      requirement_id,
      revision: requirement?.latest_revision ?? 0,
      publication_path: remoteReady ? "github_pull_request" : "local",
      publication_reason: remoteReady
        ? "当前远端 ready：预计创建并合并 GitHub PR（Run 启动时冻结）。"
        : "当前远端未 ready：预计 fast-forward 本地主分支（Run 启动时冻结）。",
      model_roles: DEMO_MODEL_ROLES,
      soft_threshold: DEMO_SOFT_THRESHOLD,
      workspace_dirty: dirty,
      workspace_note: dirty
        ? "主工作区存在未提交修改：需求可入队，Run 将停在 waiting_workspace（PRD-PROJ-005）。"
        : null,
    };
  }

  async confirmRequirement(input: {
    requirement_id: string;
    revision: number;
  }): Promise<{ run_id: string | null; conflict: boolean }> {
    await this.deps.latency();
    const requirement = this.requirements.get(input.requirement_id);
    if (!requirement) return { run_id: null, conflict: true };
    if (
      input.revision !== requirement.latest_revision ||
      requirement.state !== "spec_ready"
    ) {
      return { run_id: null, conflict: true };
    }
    const queuePosition =
      Math.max(
        0,
        ...[...this.requirements.values()].map(
          (entry) => entry.queue_position ?? 0,
        ),
      ) + 1;
    // 确认事实写回 revision（确认节点指向特定 revision，PRD-SPEC-006）
    const list = this.revisions.get(requirement.id) ?? [];
    const latest = list.at(-1);
    if (latest) {
      const confirmed: RequirementRevision = {
        ...latest,
        confirmation: { revision: latest.revision, confirmed_at: now() },
      };
      this.revisions.set(requirement.id, [...list.slice(0, -1), confirmed]);
      this.deps.emit(
        "requirement",
        requirement.id,
        "requirement.revision_created",
        { revision: confirmed },
      );
    }
    this.patchRequirement(requirement.id, {
      state: "queued",
      confirmed_revision: input.revision,
      queue_position: queuePosition,
    });
    // 严格 FIFO（PRD-RUN-001）：无活动 Run 时队首立即启动，否则排队等待
    this.maybeStartNext();
    const activeRun = requirement.latest_run_id;
    return { run_id: activeRun, conflict: false };
  }

  /** 队首需求生成 WorkPlan 并启动 Run（无计划确认步骤，PRD-RUN-002） */
  private maybeStartNext() {
    const hasActive = [...this.runs.values()].some(
      (run) => run.phase !== "terminal",
    );
    if (hasActive) return;
    const head = [...this.requirements.values()]
      .filter((requirement) => {
        if (
          requirement.state !== "queued" &&
          requirement.state !== "confirmed"
        ) {
          return false;
        }
        if (requirement.confirmed_revision === null) return false;
        // 只有"尚无 Run"或"最新 Run 已取消（语义修改后重新确认）"才启动新 Run；
        // delivered/blocked 终态不会自动重启（PRD-RUN-007 只有显式重试/放弃）
        const latestRun = requirement.latest_run_id
          ? this.runs.get(requirement.latest_run_id)
          : undefined;
        return !latestRun || latestRun.outcome === "cancelled";
      })
      .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0))[0];
    if (!head) return;
    const requirement = this.requirements.get(head.id)!;
    const revision = requirement.confirmed_revision!;
    // Run 启动时冻结发布路径（PRD-PUB-003）
    const runId = this.nextId("run");
    const path = this.director.flag("remote_ready")
      ? "github_pull_request"
      : "local";
    const run: Run = {
      id: runId,
      requirement_id: requirement.id,
      requirement_revision: revision,
      phase: "queued",
      resume_phase: null,
      outcome: null,
      blocked_reason: null,
      cancel_reason: null,
      current_activity: "已获得仓库写锁，即将进入 planning。",
      publication_path: path,
      publication_frozen_reason: frozenReason(path),
      created_at: now(),
      updated_at: now(),
    };
    this.runs.set(runId, run);
    this.deps.emit("run", runId, "run.updated", { run });
    const publication: Publication = {
      run_id: runId,
      path,
      frozen_reason: frozenReason(path),
      state: "not_started",
      branch: path === "local" ? "main" : DEMO_BRANCH,
      commit: null,
      pr_url: null,
      ci_fix_attempts: 0,
      remote_merged: false,
      local_synced: false,
      blocked_reason: null,
    };
    this.publications.set(runId, publication);
    this.deps.emit("run", runId, "publication.updated", { publication });
    this.patchRequirement(requirement.id, { latest_run_id: runId });
    void this.driveRun(runId);
  }

  async reorderQueue(input: {
    requirement_ids: string[];
  }): Promise<{ ok: boolean }> {
    await this.deps.latency();
    // 活动项（含 waiting_workspace 的 Run）不可移动（PRD-RUN-001）
    for (const id of input.requirement_ids) {
      const requirement = this.requirements.get(id);
      const run = requirement?.latest_run_id
        ? this.runs.get(requirement.latest_run_id)
        : undefined;
      if (run && run.phase !== "terminal") return { ok: false };
    }
    input.requirement_ids.forEach((id, index) => {
      this.patchRequirement(id, { queue_position: index + 1 });
    });
    this.deps.emit("requirement", "queue", "requirement.queue_reordered", {
      requirement_ids: input.requirement_ids,
    });
    return { ok: true };
  }

  /* ── Run 控制 ── */

  async pauseRun(runId: string): Promise<void> {
    await this.deps.latency();
    const run = this.runs.get(runId);
    if (!run || run.phase !== "executing") return;
    // PRD-RUN-004：进行中的工作项继续完成，调度器随后停止
    this.pauseRequested.add(runId);
    this.patchRun(runId, {
      phase: "pausing",
      resume_phase: "executing",
      current_activity: "已请求暂停：进行中的工作项继续完成，随后进入 paused。",
    });
  }

  async resumeRun(runId: string): Promise<void> {
    await this.deps.latency();
    const run = this.runs.get(runId);
    if (!run || run.phase !== "paused") return;
    this.pauseRequested.delete(runId);
    this.patchRun(runId, {
      phase: run.resume_phase ?? "executing",
      resume_phase: null,
      current_activity: "已恢复：继续调度后续工作项。",
    });
    this.director.decide(runId, "resume", "resume");
  }

  /** blocked → 重试（重置相关修复上限继续，PRD-RUN-007） */
  async retryRun(runId: string): Promise<void> {
    await this.deps.latency();
    const run = this.runs.get(runId);
    if (!run || run.phase !== "blocked") return;
    this.resolveBlockedNotification(runId);
    this.patchRun(runId, {
      phase: run.resume_phase ?? "executing",
      resume_phase: null,
      blocked_reason: null,
      current_activity: "已重试：修复上限已重置，继续执行。",
    });
    this.director.decide(runId, "blocked", "retry");
  }

  async updateWorkItem(input: {
    run_id: string;
    item_id: string;
    patch: Partial<
      Pick<WorkItem, "title" | "scenario_ids" | "verification_target">
    >;
  }): Promise<{ plan_revision: number }> {
    await this.deps.latency();
    const run = this.runs.get(input.run_id);
    const plan = this.plans.get(input.run_id);
    if (!run || !plan || run.phase !== "paused") {
      return { plan_revision: plan?.revision ?? 0 };
    }
    const items = plan.items.map((item) =>
      item.id === input.item_id && item.status === "pending"
        ? { ...item, ...input.patch }
        : item,
    );
    const requirement = this.requirements.get(run.requirement_id);
    const revisionDoc = requirement
      ? this.revisions.get(requirement.id)?.at(-1)
      : undefined;
    // PRD-RUN-005：计划修改生成新 revision 并重新校验 DAG / 场景覆盖 / 并行安全
    const next: WorkPlan = {
      ...plan,
      revision: plan.revision + 1,
      items,
      validation: validateWorkPlan(items, revisionDoc?.spec.scenarios ?? []),
    };
    this.plans.set(input.run_id, next);
    this.deps.emit("run", input.run_id, "plan.updated", { plan: next });
    return { plan_revision: next.revision };
  }

  /* ── 危险操作确认链（FE-CANVAS-019） ── */

  private static readonly ACTION_TEXT: Record<
    PendingActionKind,
    { title: string; impact: string; irreversible: boolean }
  > = {
    force_deliver_unreviewed: {
      title: "未经审核交付",
      impact:
        "reviewer 不可用，跳过审核直接发布。该确认形成永久事实节点，结果不可撤销。",
      irreversible: true,
    },
    abandon_run: {
      title: "放弃 Run",
      impact:
        "Run 转入终态（RunOutcome=blocked），保留现场事实与诊断。只有显式放弃才转终态（PRD-RUN-007）。",
      irreversible: true,
    },
    publication_retry: {
      title: "重试发布",
      impact:
        "prepare/confirm 两阶段：在受管分支重新推送并请求远端合并（PRD-PUB-007）。",
      irreversible: false,
    },
  };

  async requestAction(input: {
    kind: PendingActionKind;
    run_id: string;
  }): Promise<{ action_id: string }> {
    await this.deps.latency();
    const run = this.runs.get(input.run_id);
    const text = DeliveryModule.ACTION_TEXT[input.kind];
    const action: PendingAction = {
      id: this.nextId("act"),
      kind: input.kind,
      run_id: input.run_id,
      requirement_id: run?.requirement_id ?? null,
      title: text.title,
      impact: text.impact,
      irreversible: text.irreversible,
      state: "awaiting",
      result: null,
      created_at: now(),
    };
    this.actions.set(action.id, action);
    this.deps.emit("action", action.id, "action.updated", { action });
    return { action_id: action.id };
  }

  private patchAction(id: string, patch: Partial<PendingAction>) {
    const current = this.actions.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.actions.set(id, next);
    this.deps.emit("action", id, "action.updated", { action: next });
  }

  async confirmAction(actionId: string): Promise<void> {
    await this.deps.latency();
    const action = this.actions.get(actionId);
    if (!action || action.state !== "awaiting") return;
    this.patchAction(actionId, { state: "confirmed" });
    if (action.kind === "abandon_run") {
      this.resolveBlockedNotification(action.run_id);
      this.director.decide(action.run_id, "blocked", "abandon");
      this.patchAction(actionId, {
        result: { ok: true, message: "已放弃：Run 转入终态（blocked）。" },
      });
    } else if (action.kind === "force_deliver_unreviewed") {
      this.resolveBlockedNotification(action.run_id);
      this.director.decide(action.run_id, "blocked", "force_deliver");
      this.patchAction(actionId, {
        result: {
          ok: true,
          message: "已记录永久事实：未经审核交付，继续发布。",
        },
      });
    } else {
      this.resolveBlockedNotification(action.run_id);
      this.director.decide(action.run_id, "blocked", "pub_retry");
      this.patchAction(actionId, {
        result: { ok: true, message: "已重试发布：远端检查通过并合并。" },
      });
    }
  }

  async cancelAction(actionId: string): Promise<void> {
    await this.deps.latency();
    const action = this.actions.get(actionId);
    if (!action || action.state !== "awaiting") return;
    this.patchAction(actionId, {
      state: "cancelled",
      result: { ok: true, message: "已取消：未执行任何变更。" },
    });
  }

  /* ── 演示控制台 ── */

  getScenarioState(): Promise<ScenarioState> {
    return Promise.resolve(this.director.getState());
  }

  async scenarioControl(command: ScenarioCommand): Promise<ScenarioState> {
    await this.deps.latency();
    const state = this.director.command(command);
    if (
      command.type === "set_flag" &&
      command.flag === "dirty_workspace" &&
      !command.value
    ) {
      this.director.decideAll("workspace", "clean");
    }
    return state;
  }

  /* ── Run 导演脚本 ── */

  private patchRun(id: string, patch: Partial<Run>) {
    const current = this.runs.get(id);
    if (!current) return;
    const next = { ...current, ...patch, updated_at: now() };
    this.runs.set(id, next);
    this.deps.emit("run", id, "run.updated", { run: next });
  }

  private patchPlan(runId: string, mutate: (plan: WorkPlan) => WorkPlan) {
    const current = this.plans.get(runId);
    if (!current) return;
    const next = mutate(current);
    this.plans.set(runId, next);
    this.deps.emit("run", runId, "plan.updated", { plan: next });
  }

  private patchPublication(runId: string, patch: Partial<Publication>) {
    const current = this.publications.get(runId);
    if (!current) return;
    const next = { ...current, ...patch };
    this.publications.set(runId, next);
    this.deps.emit("run", runId, "publication.updated", { publication: next });
  }

  private setValidation(runId: string, validation: RunValidation) {
    this.validations.set(runId, validation);
    this.deps.emit("run", runId, "validation.updated", { validation });
  }

  private setReview(runId: string, review: RunReview) {
    this.reviews.set(runId, review);
    this.deps.emit("run", runId, "review.updated", { review });
  }

  private raiseBlocked(runId: string, reason: string, message: string) {
    this.patchRun(runId, {
      phase: "blocked",
      blocked_reason: reason,
      current_activity: null,
    });
    const notificationId = this.deps.notify(
      "action_required",
      message,
      "delivery",
      runId,
    );
    this.blockedNotifications.set(runId, notificationId);
  }

  private resolveBlockedNotification(runId: string) {
    const notificationId = this.blockedNotifications.get(runId);
    if (notificationId) {
      this.blockedNotifications.delete(runId);
      this.deps.resolveNotification(notificationId);
    }
  }

  private async driveRun(runId: string) {
    try {
      this.director.throwIfCancelled(runId);
      if (this.director.flag("dirty_workspace")) {
        // PRD-PROJ-005：可入队，Run 停在 waiting_workspace，不 stash 不覆盖
        this.patchRun(runId, {
          phase: "waiting_workspace",
          current_activity:
            "主工作区存在未提交修改：执行尚未开始。问答与需求准备仍可使用；在演示控制台清除「脏工作区」后继续。",
        });
        this.deps.notify(
          "warning",
          "主工作区存在未提交修改：Run 停在 waiting_workspace（不 stash、不覆盖）。",
          "delivery",
          runId,
        );
        await this.director.waitDecision(runId, "workspace");
      }
      await this.phasePlanning(runId);
      await this.phaseExecuting(runId);
      if (await this.phaseValidating(runId)) return;
      if (await this.phaseReviewing(runId)) return;
      if (await this.phasePublishing(runId)) return;
      const run = this.runs.get(runId)!;
      this.patchRun(runId, {
        phase: "terminal",
        outcome: "delivered",
        current_activity: null,
      });
      const summary = qualitySummary({
        run: { ...run, phase: "terminal", outcome: "delivered" },
        validation: this.validations.get(runId) ?? null,
        review: this.reviews.get(runId) ?? null,
      });
      this.deps.notify("success", `交付完成：${summary}`, "delivery", runId);
      this.maybeStartNext();
    } catch (error) {
      if (error instanceof RunCancelled) {
        // PRD-RUN-008：保留现场事实与取消原因
        this.patchRun(runId, {
          phase: "terminal",
          outcome: "cancelled",
          cancel_reason: error.message,
          current_activity: null,
        });
        this.resolveBlockedNotification(runId);
        this.maybeStartNext();
        return;
      }
      throw error;
    }
  }

  private async phasePlanning(runId: string) {
    this.patchRun(runId, {
      phase: "planning",
      current_activity:
        "planner 正在生成 WorkPlan（行为切片 / 依赖 / 场景引用）…",
    });
    await this.director.gate(runId, "planning");
    const plan = buildDemoPlan(this.nextId("plan"), runId, 1);
    this.plans.set(runId, plan);
    this.deps.emit("run", runId, "plan.updated", { plan });
    this.patchRun(runId, {
      current_activity:
        "WorkPlan 已生成并自动执行（无计划确认步骤）：2 个并行切片 → 合并任务 → 1 个串行收尾。",
    });
    await this.director.gate(runId, "plan-created");
  }

  private mutateItem(
    runId: string,
    itemId: string,
    mutate: (item: WorkItem) => WorkItem,
  ) {
    this.patchPlan(runId, (plan) => ({
      ...plan,
      items: plan.items.map((item) =>
        item.id === itemId ? mutate(item) : item,
      ),
    }));
  }

  private startAttempt(
    runId: string,
    itemId: string,
    attempt: Omit<Attempt, "started_at" | "finished_at">,
  ) {
    this.mutateItem(runId, itemId, (item) => ({
      ...item,
      status: "running",
      attempts: [
        ...item.attempts,
        { ...attempt, started_at: now(), finished_at: null },
      ],
    }));
  }

  private finishAttempt(
    runId: string,
    itemId: string,
    status: "completed" | "failed",
    patch?: Partial<WorkItem>,
  ) {
    this.mutateItem(runId, itemId, (item) => ({
      ...item,
      status: status === "completed" ? "completed" : item.status,
      ...patch,
      attempts: item.attempts.map((attempt, index) =>
        index === item.attempts.length - 1
          ? { ...attempt, status, finished_at: now() }
          : attempt,
      ),
    }));
  }

  /** 暂停检查：工作项完成后调度器停止（PRD-RUN-004） */
  private async maybePause(runId: string) {
    if (!this.pauseRequested.has(runId)) return;
    this.patchRun(runId, {
      phase: "paused",
      current_activity:
        "已暂停：可编辑 pending 工作项、依赖与验证目标（生成新 plan revision）。",
    });
    await this.director.waitDecision(runId, "resume");
    this.director.throwIfCancelled(runId);
  }

  private async phaseExecuting(runId: string) {
    const plan = this.plans.get(runId)!;
    const [wi1, wi2, mt1, wi3] = plan.items.map((item) => item.id);
    this.patchRun(runId, {
      phase: "executing",
      current_activity: "并行批 1：两个独立切片在各自 worktree 实现。",
    });
    this.startAttempt(runId, wi1, {
      index: 1,
      kind: "implementation",
      model: "fake-code-large",
      upgraded: false,
      status: "running",
      summary: null,
    });
    this.startAttempt(runId, wi2, {
      index: 1,
      kind: "implementation",
      model: "fake-code-large",
      upgraded: false,
      status: "running",
      summary: null,
    });
    await this.director.gate(runId, "batch-1");
    this.finishAttempt(runId, wi1, "completed", {
      artifact_summary: "runtime.ts 入队支持优先级；新增 peek()。",
    });
    this.finishAttempt(runId, wi2, "completed", {
      artifact_summary: "queue.ts 队列投影按计划序排序。",
    });
    await this.maybePause(runId);
    // 显式合并任务（PRD-RUN-006）：冲突由 implementer 在 integration worktree 解决
    this.patchRun(runId, {
      current_activity: "合并任务：按计划序合并到 integration 分支。",
    });
    this.startAttempt(runId, mt1, {
      index: 1,
      kind: "implementation",
      model: "fake-code-large",
      upgraded: false,
      status: "running",
      summary: null,
    });
    await this.director.gate(runId, "merge");
    this.finishAttempt(runId, mt1, "completed", {
      conflict_resolution:
        "合并 工作流运行时状态切片：无冲突。合并 需求列表投影切片：src/store/queue.ts 与批内另一切片冲突，implementer 在 integration worktree 编辑解决（保留双方新增），后端验证 diff 后创建受管提交。",
      artifact_summary: "integration 受管提交 c4f5a6b。",
    });
    await this.maybePause(runId);
    // 串行收尾工作项
    this.patchRun(runId, {
      current_activity: "并行批 2（串行收尾）：交付报告组合切片。",
    });
    if (this.director.flag("rescue_demo")) {
      // rescue 演示：1 实现 + 2 修复不收敛 → 第 3 次升级模型 → rescue 一次（PRD-QUAL-006/RUN-009）
      this.startAttempt(runId, wi3, {
        index: 1,
        kind: "implementation",
        model: "fake-code-large",
        upgraded: false,
        status: "running",
        summary: null,
      });
      await this.director.gate(runId, "wi3-a1");
      this.finishAttempt(runId, wi3, "failed");
      this.startAttempt(runId, wi3, {
        index: 2,
        kind: "fix",
        model: "fake-code-large",
        upgraded: false,
        status: "running",
        summary: "修复类型错误",
      });
      await this.director.gate(runId, "wi3-a2");
      this.finishAttempt(runId, wi3, "failed");
      this.startAttempt(runId, wi3, {
        index: 3,
        kind: "fix",
        model: "fake-code-xl",
        upgraded: true,
        status: "running",
        summary: "第 3 次 attempt：升级到更强模型",
      });
      await this.director.gate(runId, "wi3-a3");
      this.finishAttempt(runId, wi3, "failed");
      this.startAttempt(runId, wi3, {
        index: 4,
        kind: "rescue",
        model: "fake-code-xl",
        upgraded: true,
        status: "running",
        summary: "rescue：更强模型 + 全新上下文会话重新开始（整个 Run 仅一次）",
      });
      await this.director.gate(runId, "wi3-rescue");
      this.finishAttempt(runId, wi3, "completed", {
        artifact_summary: "报告组合完成：结果 / 位置 / 证据 / 质量 / 建议。",
      });
    } else {
      this.startAttempt(runId, wi3, {
        index: 1,
        kind: "implementation",
        model: "fake-code-large",
        upgraded: false,
        status: "running",
        summary: null,
      });
      await this.director.gate(runId, "wi3");
      this.finishAttempt(runId, wi3, "completed", {
        artifact_summary: "报告组合完成：结果 / 位置 / 证据 / 质量 / 建议。",
      });
    }
  }

  private computeOverall(entries: ValidationEntry[]): VerificationVerdict {
    if (entries.some((entry) => entry.verdict === "new_regression")) {
      return "new_regression";
    }
    if (entries.some((entry) => entry.verdict === "unavailable")) {
      return "unavailable";
    }
    if (entries.some((entry) => entry.verdict === "baseline_issues_only")) {
      return "baseline_issues_only";
    }
    return "clean";
  }

  /** @returns true 表示 Run 已终态（abandon），调用方直接返回 */
  private async phaseValidating(runId: string): Promise<boolean> {
    this.patchRun(runId, {
      phase: "validating",
      current_activity: "运行验证命令并与基线对比（只阻断新增/恶化失败）。",
    });
    const entries = demoValidationEntries();
    const newRegression = this.director.flag("new_regression");
    // 逐条产出验证结果
    entries[0] = {
      ...entries[0],
      final: { exit_code: 0, summary: "0 errors" },
      verdict: "clean",
    };
    this.setValidation(runId, {
      run_id: runId,
      entries: [...entries],
      overall: this.computeOverall(entries),
    });
    await this.director.gate(runId, "validate-1");
    entries[1] = newRegression
      ? {
          ...entries[1],
          baseline: { exit_code: 0, summary: "全部通过" },
          final: { exit_code: 1, summary: "新增失败：store/queue.test.ts" },
          verdict: "new_regression",
        }
      : {
          ...entries[1],
          final: { exit_code: 1, summary: "同一历史失败，无新增" },
          verdict: "baseline_issues_only",
        };
    this.setValidation(runId, {
      run_id: runId,
      entries: [...entries],
      overall: this.computeOverall(entries),
    });
    await this.director.gate(runId, "validate-2");
    entries[2] = {
      ...entries[2],
      final: { exit_code: 0, summary: "0 warnings" },
      verdict: "clean",
    };
    this.setValidation(runId, {
      run_id: runId,
      entries: [...entries],
      overall: this.computeOverall(entries),
    });
    if (!newRegression) return false;
    // 新回归：修复 attempt 不收敛 → blocked（PRD-QUAL-006、AC-05）
    this.patchRun(runId, {
      current_activity: "新增回归：implementer 修复（第 1 次修复）。",
    });
    await this.director.gate(runId, "regression-fix-1");
    this.patchRun(runId, {
      current_activity: "新增回归：第 2 次修复（升级模型 fake-code-xl）。",
    });
    await this.director.gate(runId, "regression-fix-2");
    this.patchRun(runId, { resume_phase: "validating" });
    this.raiseBlocked(
      runId,
      "修复上限（1 实现 + 2 修复）耗尽，新增回归未收敛：store/queue.test.ts 仍失败。",
      "Run 阻断：新增回归修复未收敛。重试将重置修复上限，放弃则转入终态。",
    );
    const decision = await this.director.waitDecision(runId, "blocked");
    if (decision === "abandon") {
      this.patchRun(runId, {
        phase: "terminal",
        outcome: "blocked",
        current_activity: null,
      });
      this.maybeStartNext();
      return true;
    }
    // retry：修复上限重置后复验通过（保留历史失败事实）
    this.director.command({
      type: "set_flag",
      flag: "new_regression",
      value: false,
    });
    const repaired = demoValidationEntries().map((entry, index) =>
      index === 1
        ? {
            ...entry,
            final: { exit_code: 1, summary: "同一历史失败，无新增" },
            verdict: "baseline_issues_only" as const,
          }
        : {
            ...entry,
            final: { exit_code: 0, summary: entry.baseline?.summary ?? "" },
            verdict: "clean" as const,
          },
    );
    this.setValidation(runId, {
      run_id: runId,
      entries: repaired,
      overall: this.computeOverall(repaired),
    });
    return false;
  }

  /** @returns true 表示 Run 已终态（abandon） */
  private async phaseReviewing(runId: string): Promise<boolean> {
    this.patchRun(runId, {
      phase: "reviewing",
      current_activity:
        "三角度独立审核（输入隔离）：correctness / quality / security。",
    });
    const angles = demoReviewAngles();
    // correctness 恒有，且只有 correctness 可见规格与验收场景
    this.setReview(runId, {
      run_id: runId,
      angles: [angles[0]],
      overall: "approved",
    });
    await this.director.gate(runId, "review-correctness");
    if (this.director.flag("review_unavailable")) {
      // PRD-QUAL-008：unavailable 默认阻断；可经确认链「未经审核交付」
      const unavailable = angles.map((angle) => ({
        ...angle,
        verdict: "unavailable" as ReviewVerdict,
        findings: [],
      }));
      this.setReview(runId, {
        run_id: runId,
        angles: unavailable,
        overall: "unavailable",
      });
      this.patchRun(runId, { resume_phase: "reviewing" });
      this.raiseBlocked(
        runId,
        "reviewer 不可用或输出无效：默认阻断自动发布（PRD-QUAL-008），不伪造 approved。",
        "Run 阻断：审核不可用。重试审核，或经确认链选择「未经审核交付」。",
      );
      const decision = await this.director.waitDecision(runId, "blocked");
      if (decision === "abandon") {
        this.patchRun(runId, {
          phase: "terminal",
          outcome: "blocked",
          current_activity: null,
        });
        this.maybeStartNext();
        return true;
      }
      if (decision === "force_deliver") {
        // 永久事实：review 保持 unavailable，继续发布
        return false;
      }
      this.director.command({
        type: "set_flag",
        flag: "review_unavailable",
        value: false,
      });
    }
    // quality round 1：P1 阻断 + P2 建议（AC-06）
    this.setReview(runId, {
      run_id: runId,
      angles: [angles[0], angles[1]],
      overall: "blocking_findings",
    });
    this.patchRun(runId, {
      current_activity:
        "quality 角度发现 1 个 P1：修复（复用工作项 attempt 上限）后复审受影响角度。",
    });
    await this.director.gate(runId, "review-quality-r1");
    // P1 修复：复用第一个工作项的 attempt 2
    const plan = this.plans.get(runId)!;
    const firstItem = plan.items.find((item) => item.kind === "work_item")!;
    this.startAttempt(runId, firstItem.id, {
      index: 2,
      kind: "fix",
      model: "fake-code-large",
      upgraded: false,
      status: "running",
      summary: "修复 P1：排序比较器处理相等优先级",
    });
    await this.director.gate(runId, "review-fix");
    this.finishAttempt(runId, firstItem.id, "completed");
    // quality round 2：只复查受影响角度，P1 resolved，P2 留存
    const qualityRound2 = {
      ...angles[1],
      verdict: "approved_with_advisories" as ReviewVerdict,
      rounds: 2,
      findings: angles[1].findings.map((finding) =>
        finding.priority === "P1" ? { ...finding, resolved: true } : finding,
      ),
    };
    this.setReview(runId, {
      run_id: runId,
      angles: [angles[0], qualityRound2],
      overall: "approved_with_advisories",
    });
    await this.director.gate(runId, "review-quality-r2");
    // security：敏感路径（runtime 并发/队列）触发第三角度
    this.setReview(runId, {
      run_id: runId,
      angles: [angles[0], qualityRound2, angles[2]],
      overall: "approved_with_advisories",
    });
    await this.director.gate(runId, "review-security");
    return false;
  }

  /** @returns true 表示 Run 已终态（abandon） */
  private async phasePublishing(runId: string): Promise<boolean> {
    const run = this.runs.get(runId)!;
    this.patchRun(runId, {
      phase: "publishing",
      current_activity:
        "发布由后端状态机独占执行（模型不能 commit/push/merge）。",
    });
    this.patchPublication(runId, { state: "preparing" });
    await this.director.gate(runId, "pub-prepare");
    if (run.publication_path === "local") {
      // 本地主分支 fast-forward（PRD-PUB-003 回退路径，质量门槛不降低）
      this.patchPublication(runId, { state: "merged", commit: DEMO_COMMIT });
      this.patchRun(runId, {
        current_activity: "本地交付：fast-forward 主分支（本地回退路径可见）。",
      });
      await this.director.gate(runId, "pub-local-merge");
      this.patchPublication(runId, {
        state: "completed",
        remote_merged: true,
        local_synced: true,
        commit: DEMO_COMMIT,
      });
      return false;
    }
    // PR 路径：创建并合并 GitHub PR，远端 CI 失败一次修复（PRD-PUB-007）
    this.patchPublication(runId, { state: "pushed", branch: DEMO_BRANCH });
    this.patchRun(runId, {
      current_activity: `推送受管分支 ${DEMO_BRANCH}。`,
    });
    await this.director.gate(runId, "pub-push");
    this.patchPublication(runId, { state: "review_open", pr_url: DEMO_PR_URL });
    this.patchRun(runId, { current_activity: `已创建 PR：${DEMO_PR_URL}` });
    await this.director.gate(runId, "pub-pr");
    this.patchPublication(runId, { state: "waiting_remote" });
    this.patchRun(runId, { current_activity: "等待远端必要检查…" });
    await this.director.gate(runId, "pub-ci-wait");
    if (this.director.flag("ci_fail_once")) {
      this.patchRun(runId, {
        current_activity:
          "远端 CI 失败：implementer 在受管分支修复推送（仅 1 次）。",
      });
      this.patchPublication(runId, { ci_fix_attempts: 1 });
      await this.director.gate(runId, "pub-ci-fix");
      if (this.director.flag("ci_reject")) {
        // 仍失败 / 远端拒绝合并 → blocked + ActionRequired（PRD-PUB-007）
        this.patchPublication(runId, {
          state: "failed",
          blocked_reason: "CI 修复推送后远端必要检查仍失败（保护分支策略）。",
        });
        this.patchRun(runId, { resume_phase: "publishing" });
        this.raiseBlocked(
          runId,
          "远端必要检查仍失败：CI 修复机会已用尽（PRD-PUB-007）。",
          "Run 阻断：远端检查未通过。可经确认链重试发布，或放弃。",
        );
        const decision = await this.director.waitDecision(runId, "blocked");
        if (decision === "abandon") {
          this.patchRun(runId, {
            phase: "terminal",
            outcome: "blocked",
            current_activity: null,
          });
          this.maybeStartNext();
          return true;
        }
        this.patchPublication(runId, {
          state: "waiting_remote",
          blocked_reason: null,
        });
        await this.director.gate(runId, "pub-ci-retry");
      }
    }
    this.patchPublication(runId, { state: "merged", remote_merged: true });
    this.patchRun(runId, { current_activity: "远端已合并，同步本地主分支…" });
    await this.director.gate(runId, "pub-merged");
    this.patchPublication(runId, { state: "syncing_local" });
    await this.director.gate(runId, "pub-sync");
    if (this.director.flag("local_sync_fail")) {
      // PRD-PUB-006：远端已交付 · 本地待同步（两个事实组合展示）
      this.patchPublication(runId, {
        state: "completed",
        commit: DEMO_COMMIT,
        local_synced: false,
        blocked_reason: "本地同步失败：远端已交付，本地待同步。",
      });
    } else {
      this.patchPublication(runId, {
        state: "completed",
        commit: DEMO_COMMIT,
        local_synced: true,
      });
    }
    return false;
  }
}
