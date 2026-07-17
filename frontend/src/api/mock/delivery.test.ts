import { describe, expect, it } from "vitest";
import { createEventApplier } from "../../events/applier";
import { createNdjsonDecoder } from "../../events/ndjson";
import { countAdvisories } from "../quality";
import { useDomainStore } from "../../store/domainStore";
import { FakeBackend } from "./backend";

/**
 * 需求交付假数据层端到端：命令 → NDJSON 事件流 → 领域投影（与生产同路径）。
 * 覆盖：全流程自动交付、发布冻结、revision/语义修改、blocked 确认链、队列重排。
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function waitForAsync(
  condition: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitForAsync 超时");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function connectBackendToDomain(backend: FakeBackend, after: number) {
  const applier = createEventApplier(after, {
    apply: (envelope) => useDomainStore.getState().applyEvent(envelope),
    onResyncNeeded: () => {
      throw new Error("演示流不应出现序号缺口");
    },
  });
  const decoder = createNdjsonDecoder({
    onLine: (line) => applier.handle(JSON.parse(line)),
  });
  void backend.openEventStream(after).then(async (stream) => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) decoder.write(value);
    }
  });
}

const domain = () => useDomainStore.getState();

async function bootBackend(): Promise<FakeBackend> {
  const backend = new FakeBackend();
  const snapshot = await backend.getSnapshot();
  domain().initFromSnapshot(snapshot);
  connectBackendToDomain(backend, snapshot.last_sequence);
  await backend.scenarioControl({ type: "set_step_delay", value: 0 });
  return backend;
}

/** 创建需求 → 回答澄清 → 规格 ready */
async function createToSpecReady(
  backend: FakeBackend,
  title: string,
): Promise<string> {
  const { requirement_id } = await backend.createRequirementFromChat({
    branch_id: "b-main",
    node_ids: [],
    title,
  });
  await waitFor(() =>
    Object.values(domain().clarifications).some(
      (round) =>
        round.requirement_id === requirement_id && round.state === "pending",
    ),
  );
  const round = Object.values(domain().clarifications).find(
    (entry) => entry.requirement_id === requirement_id,
  )!;
  await backend.answerClarification({
    requirement_id,
    round_id: round.id,
    answer: "工作流执行语义",
  });
  await waitFor(
    () => domain().requirements[requirement_id]?.state === "spec_ready",
  );
  return requirement_id;
}

async function confirmLatest(
  backend: FakeBackend,
  requirementId: string,
): Promise<string> {
  const requirement = domain().requirements[requirementId];
  const result = await backend.confirmRequirement({
    requirement_id: requirementId,
    revision: requirement.latest_revision,
  });
  expect(result.conflict).toBe(false);
  return requirementId;
}

describe("需求交付假后端（P2 演示流程）", () => {
  it("全流程：澄清 → 确认 → 自动规划/执行/验证/审核/发布 → 已交付组合结论", async () => {
    const backend = await bootBackend();
    const requirementId = await createToSpecReady(backend, "全流程演示需求");
    expect(domain().revisions[requirementId]).toHaveLength(1);
    await confirmLatest(backend, requirementId);

    await waitFor(() => {
      const requirement = domain().requirements[requirementId];
      const run = requirement.latest_run_id
        ? domain().runs[requirement.latest_run_id]
        : undefined;
      return run?.phase === "terminal";
    });

    const requirement = domain().requirements[requirementId];
    const run = domain().runs[requirement.latest_run_id!];
    expect(run.outcome).toBe("delivered");

    // WorkPlan：显式合并任务 + 冲突解决事实
    const plan = domain().plans[run.id];
    expect(plan.validation.ok).toBe(true);
    const mergeTask = plan.items.find((item) => item.kind === "merge_task")!;
    expect(mergeTask.status).toBe("completed");
    expect(mergeTask.conflict_resolution).toContain("冲突");

    // 质量：基线失败显著但不阻断；P1 修复后 2 个建议留存
    expect(domain().validations[run.id].overall).toBe("baseline_issues_only");
    const review = domain().reviews[run.id];
    expect(review.overall).toBe("approved_with_advisories");
    expect(countAdvisories(review)).toBe(2);
    expect(review.angles.map((angle) => angle.angle)).toEqual([
      "correctness",
      "quality",
      "security",
    ]);

    // 发布：PR 路径 + CI 失败一次修复 + 远端本地均完成
    const publication = domain().publications[run.id];
    expect(publication.path).toBe("github_pull_request");
    expect(publication.state).toBe("completed");
    expect(publication.ci_fix_attempts).toBe(1);
    expect(publication.remote_merged && publication.local_synced).toBe(true);
    expect(publication.pr_url).toContain("github.com");

    // 组合文案（禁止单一"完成"）+ 成功通知进入 GrayDango 队列
    const success = Object.values(domain().notifications).find(
      (notification) =>
        notification.severity === "success" &&
        notification.source_node_id === run.id,
    );
    expect(success?.message).toContain("已交付 · 仅基线失败 · 2 个 P2/P3 建议");
  }, 20_000);

  it("发布冻结：确认时远端未 ready → 本地 FF；运行期间翻转 flag 不改变路径", async () => {
    const backend = await bootBackend();
    await backend.scenarioControl({
      type: "set_flag",
      flag: "remote_ready",
      value: false,
    });
    const requirementId = await createToSpecReady(backend, "冻结演示需求");
    await confirmLatest(backend, requirementId);

    const requirement = () => domain().requirements[requirementId];
    await waitFor(() => Boolean(requirement().latest_run_id));
    const runId = requirement().latest_run_id!;
    // Run 启动即冻结为 local（PRD-PUB-003）
    expect(domain().publications[runId].path).toBe("local");
    expect(domain().publications[runId].frozen_reason).toContain(
      "远端未 ready",
    );

    // 运行期间远端恢复 ready：已冻结路径不变
    await backend.scenarioControl({
      type: "set_flag",
      flag: "remote_ready",
      value: true,
    });
    await waitFor(() => domain().runs[runId]?.phase === "terminal");
    const publication = domain().publications[runId];
    expect(publication.path).toBe("local");
    expect(publication.branch).toBe("main");
    expect(publication.state).toBe("completed");
    expect(domain().runs[runId].outcome).toBe("delivered");
  }, 20_000);

  it("规格 revision：证据修正不撤销确认；语义修改撤销确认并取消未终态 Run", async () => {
    const backend = await bootBackend();
    // 手动模式：脚本停在检查点，语义修改可确定性命中未终态 Run
    await backend.scenarioControl({ type: "set_autoplay", value: false });
    const requirementId = await createToSpecReady(backend, "revision 演示需求");

    // 过期基座 → 冲突（BE-SPEC-002）
    const rev1 = domain().revisions[requirementId].at(-1)!;
    const stale = await backend.updateSpec({
      requirement_id: requirementId,
      base_revision: rev1.revision + 99,
      spec: rev1.spec,
    });
    expect(stale.conflict).toBe(true);

    // 证据修正：新 revision，不触发撤销语义
    const evidenceSpec = structuredClone(rev1.spec);
    evidenceSpec.evidence = ["补充一条证据"];
    const evidenceResult = await backend.updateSpec({
      requirement_id: requirementId,
      base_revision: rev1.revision,
      spec: evidenceSpec,
    });
    expect(evidenceResult.conflict).toBe(false);
    // 事件经 NDJSON 流异步应用，等待投影更新
    await waitFor(
      () => domain().requirements[requirementId]?.latest_revision === 2,
    );
    expect(domain().requirements[requirementId].state).toBe("spec_ready");
    // 证据修正确认哈希不变
    expect(domain().revisions[requirementId].at(-1)!.semantic_hash).toBe(
      rev1.semantic_hash,
    );

    await confirmLatest(backend, requirementId);
    await waitFor(() =>
      Boolean(domain().requirements[requirementId]?.latest_run_id),
    );
    const runId = domain().requirements[requirementId].latest_run_id!;
    await waitForAsync(
      async () =>
        (await backend.getScenarioState()).awaiting_step_run_id === runId,
    );

    // 语义修改：新 revision + 撤销确认 + 取消未终态 Run（PRD-SPEC-007）
    const rev2 = domain().revisions[requirementId].at(-1)!;
    const semanticSpec = structuredClone(rev2.spec);
    semanticSpec.goal = "改变目标（语义修改）";
    await backend.updateSpec({
      requirement_id: requirementId,
      base_revision: rev2.revision,
      spec: semanticSpec,
    });
    await waitFor(() => domain().runs[runId]?.outcome === "cancelled");
    const requirement = domain().requirements[requirementId];
    expect(requirement.state).toBe("spec_ready");
    expect(requirement.confirmed_revision).toBeNull();
    expect(requirement.latest_revision).toBe(3);
    expect(domain().runs[runId].cancel_reason).toContain("语义修改");
    expect(domain().revisions[requirementId].at(-1)!.semantic_hash).not.toBe(
      rev2.semantic_hash,
    );
  }, 20_000);

  it("新回归 blocked → GrayDango action_required → 放弃确认链 → 终态与通知解除", async () => {
    const backend = await bootBackend();
    await backend.scenarioControl({
      type: "set_flag",
      flag: "new_regression",
      value: true,
    });
    const requirementId = await createToSpecReady(backend, "回归演示需求");
    await confirmLatest(backend, requirementId);
    await waitFor(() =>
      Boolean(domain().requirements[requirementId]?.latest_run_id),
    );
    const runId = domain().requirements[requirementId].latest_run_id!;

    await waitFor(() => domain().runs[runId]?.phase === "blocked");
    expect(domain().validations[runId].overall).toBe("new_regression");
    await waitFor(() =>
      Object.values(domain().notifications).some(
        (notification) =>
          notification.severity === "action_required" &&
          notification.source_node_id === runId,
      ),
    );
    const blocking = Object.values(domain().notifications).find(
      (notification) =>
        notification.severity === "action_required" &&
        notification.source_node_id === runId,
    );
    expect(blocking?.lifecycle).toBe("active");

    // 危险操作只能经确认链（FE-CANVAS-019）：request → confirm → 结果节点事实
    const { action_id } = await backend.requestAction({
      kind: "abandon_run",
      run_id: runId,
    });
    await waitFor(() => domain().actions[action_id]?.state === "awaiting");
    await backend.confirmAction(action_id);
    await waitFor(() => domain().runs[runId]?.phase === "terminal");
    expect(domain().runs[runId].outcome).toBe("blocked");
    expect(domain().actions[action_id].result?.ok).toBe(true);
    expect(domain().notifications[blocking!.id].lifecycle).toBe("resolved");
  }, 20_000);

  it("队列：活动项（含 waiting_workspace）不可移动，空闲排队项可重排", async () => {
    const backend = await bootBackend();
    // 手动模式：第一个 Run 停在检查点保持活动，第二个需求才能稳定排队
    await backend.scenarioControl({ type: "set_autoplay", value: false });
    const first = await createToSpecReady(backend, "队首需求");
    await confirmLatest(backend, first);
    await waitFor(() => Boolean(domain().requirements[first]?.latest_run_id));
    const firstRunId = domain().requirements[first].latest_run_id!;
    await waitForAsync(
      async () =>
        (await backend.getScenarioState()).awaiting_step_run_id === firstRunId,
    );
    const second = await createToSpecReady(backend, "后续需求");
    await confirmLatest(backend, second);
    // 第一个 Run 活动中：第二个需求排队但尚未获得写锁（无 Run）
    await waitFor(() => domain().requirements[second]?.queue_position !== null);
    expect(domain().requirements[second].latest_run_id).toBeNull();

    const both = await backend.reorderQueue({
      requirement_ids: [second, first],
    });
    expect(both.ok).toBe(false);
    const onlySecond = await backend.reorderQueue({
      requirement_ids: [second],
    });
    expect(onlySecond.ok).toBe(true);
    await waitFor(() => domain().requirements[second]?.queue_position === 1);
  }, 20_000);
});
