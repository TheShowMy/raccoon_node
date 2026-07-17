import { describe, expect, it } from "vitest";
import { FakeBackend } from "./backend";

/**
 * 工作台危险操作确认链（FE-CANVAS-019、FE-GIT-003）：
 * request（prepare 事实）→ confirm（token 校验 + 执行）→ 结果节点事实。
 */
describe("Git 确认链（FakeBackend 端到端）", () => {
  it("commit：awaiting → confirmed，暂存清空", async () => {
    const backend = new FakeBackend();
    const { action_id } = await backend.requestWorkbenchAction({
      kind: "git_commit",
      payload: { message: "feat: 确认链提交" },
      source_node_id: "git-commit",
    });
    let snapshot = await backend.getSnapshot();
    const awaiting = snapshot.state.workbench_actions.find(
      (action) => action.id === action_id,
    );
    expect(awaiting?.state).toBe("awaiting");
    expect(awaiting?.confirm_token).toBeTruthy();

    await backend.confirmWorkbenchAction({
      action_id,
      confirm_token: awaiting!.confirm_token,
    });
    snapshot = await backend.getSnapshot();
    const confirmed = snapshot.state.workbench_actions.find(
      (action) => action.id === action_id,
    );
    expect(confirmed?.state).toBe("confirmed");
    expect(confirmed?.result?.ok).toBe(true);
    expect(confirmed?.result?.message).toContain("确认链提交");
    expect(
      snapshot.state.git.changes.filter((change) => change.status === "staged"),
    ).toHaveLength(0);
  });

  it("token 不匹配拒绝执行（BE-API-004 两阶段契约）", async () => {
    const backend = new FakeBackend();
    const { action_id } = await backend.requestWorkbenchAction({
      kind: "git_discard",
      payload: { path: "docs/rewrite/TODO.md" },
    });
    await backend.confirmWorkbenchAction({
      action_id,
      confirm_token: "wrong-token",
    });
    const snapshot = await backend.getSnapshot();
    const action = snapshot.state.workbench_actions.find(
      (entry) => entry.id === action_id,
    );
    expect(action?.state).toBe("cancelled");
    expect(action?.result?.ok).toBe(false);
    // 未执行：变更仍在
    expect(
      snapshot.state.git.changes.some(
        (change) => change.path === "docs/rewrite/TODO.md",
      ),
    ).toBe(true);
  });

  it("cancel：不产生任何变更", async () => {
    const backend = new FakeBackend();
    const { action_id } = await backend.requestWorkbenchAction({
      kind: "git_push",
      payload: {},
    });
    await backend.cancelWorkbenchAction(action_id);
    const snapshot = await backend.getSnapshot();
    const action = snapshot.state.workbench_actions.find(
      (entry) => entry.id === action_id,
    );
    expect(action?.state).toBe("cancelled");
    expect(
      snapshot.state.git.branches.find((branch) => branch.current)?.ahead,
    ).toBe(1);
  });
});
