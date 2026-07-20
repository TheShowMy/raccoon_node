import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../types";
import { GitModule } from "./git";

function makeGit(locked = false) {
  const events: EventEnvelope[] = [];
  const module = new GitModule({
    idPrefix: "test",
    emit: (aggregateType, aggregateId, eventType, payload) => {
      events.push({
        schema_version: 1,
        sequence: events.length + 1,
        event_id: `e-${events.length + 1}`,
        occurred_at: new Date().toISOString(),
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        event_type: eventType,
        payload,
      } as EventEnvelope);
    },
    latency: () => Promise.resolve(),
    writeLock: () => ({
      locked,
      owner_run_id: locked ? "run-test-1" : null,
    }),
  });
  return { module, events };
}

describe("Git 模块（FE-GIT-002/003）", () => {
  it("stage/unstage 直接执行并经事件投影", async () => {
    const { module, events } = makeGit();
    const stagedBefore = module
      .snapshotState()
      .changes.filter((change) => change.status === "staged").length;
    const stageResult = await module.stageChanges([
      "frontend/src/canvas/nodes.tsx",
    ]);
    expect(stageResult.changed_paths).toEqual([
      "frontend/src/canvas/nodes.tsx",
    ]);
    const staged = module
      .snapshotState()
      .changes.filter((change) => change.status === "staged");
    expect(staged).toHaveLength(stagedBefore + 1);
    await module.unstageChanges(["frontend/src/canvas/nodes.tsx"]);
    expect(
      module
        .snapshotState()
        .changes.filter((change) => change.status === "staged"),
    ).toHaveLength(stagedBefore);
    expect(
      events.filter((event) => event.event_type === "git.updated").length,
    ).toBe(2);
  });

  it("未跟踪文件可暂存查看新增 Diff，并在取消暂存后恢复", async () => {
    const { module } = makeGit();
    const path = "docs/rewrite/TODO.md";
    const staged = await module.stageChanges([path]);
    expect(staged).toMatchObject({ ok: true, changed_paths: [path] });
    expect(
      module.snapshotState().changes.find((change) => change.path === path),
    ).toMatchObject({ status: "staged" });
    expect(
      module.snapshotState().changes.find((change) => change.path === path)
        ?.diff,
    ).toContain("new file mode");

    await module.unstageChanges([path]);
    expect(
      module.snapshotState().changes.find((change) => change.path === path),
    ).toMatchObject({ status: "untracked", diff: null });
  });

  it("批量操作先完整校验，失败时不修改任何路径且成功只发一个事件", async () => {
    const { module, events } = makeGit();
    const before = module.snapshotState().changes;
    const failed = await module.stageChanges([
      "frontend/src/canvas/nodes.tsx",
      "src/merge.rs",
    ]);
    expect(failed).toMatchObject({ ok: false, changed_paths: [] });
    expect(module.snapshotState().changes).toEqual(before);
    expect(events).toHaveLength(0);

    const succeeded = await module.stageChanges([
      "frontend/src/canvas/nodes.tsx",
      "docs/rewrite/TODO.md",
    ]);
    expect(succeeded.changed_paths).toHaveLength(2);
    expect(
      events.filter((event) => event.event_type === "git.updated"),
    ).toHaveLength(1);
  });

  it("commit 处理器：清空暂存并生成提交", async () => {
    const { module } = makeGit();
    const result = module.execute("git_commit", { message: "feat: 测试提交" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("feat: 测试提交");
    expect(
      module
        .snapshotState()
        .changes.filter((change) => change.status === "staged"),
    ).toHaveLength(0);
    expect(module.snapshotState().last_commit).toContain("feat: 测试提交");
  });

  it("switch/create/discard/push 处理器", async () => {
    const { module } = makeGit();
    expect(
      module.execute("git_switch_branch", { branch: "feat/canvas-polish" }).ok,
    ).toBe(true);
    expect(
      module.snapshotState().branches.find((branch) => branch.current)?.name,
    ).toBe("feat/canvas-polish");
    expect(module.execute("git_create_branch", { branch: "feat/new" }).ok).toBe(
      true,
    );
    expect(
      module.snapshotState().branches.find((branch) => branch.current)?.name,
    ).toBe("feat/new");
    expect(
      module.execute("git_discard", { path: "docs/rewrite/TODO.md" }).ok,
    ).toBe(true);
    expect(
      module
        .snapshotState()
        .changes.some((change) => change.path === "docs/rewrite/TODO.md"),
    ).toBe(false);
    // 新分支 ahead 0：push 失败
    expect(module.execute("git_push", {}).ok).toBe(false);
  });

  it("写锁占用时写操作返回 409 语义（PRD-RUN-001）", async () => {
    const { module } = makeGit(true);
    const staged = await module.stageChanges(["frontend/src/canvas/nodes.tsx"]);
    expect(staged.ok).toBe(false);
    expect(staged.message).toContain("409");
    expect(module.execute("git_commit", { message: "x" }).message).toContain(
      "409",
    );
    expect(
      module.execute("git_discard", { path: "docs/rewrite/TODO.md" }).ok,
    ).toBe(false);
  });
});
