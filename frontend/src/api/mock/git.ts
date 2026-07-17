import { GIT_LOCKED_MESSAGE } from "../git";
import type {
  DomainEventPayload,
  EventAggregateType,
  EventType,
  GitBranch,
  GitChange,
  GitRepoState,
  WorkbenchActionKind,
} from "../types";

type Emit = <T extends EventType>(
  aggregateType: EventAggregateType,
  aggregateId: string,
  eventType: T,
  payload: DomainEventPayload[T],
) => void;

const DEMO_DIFF_CANVAS = [
  "diff --git a/frontend/src/canvas/nodes.tsx b/frontend/src/canvas/nodes.tsx",
  "@@ -12,7 +12,9 @@ export function CapabilityNode() {",
  "-  const title = kind;",
  "+  const title = CAPABILITY_LABELS[kind];",
  "+  const dimmed = workbenchOpen && kind !== current;",
  "   return (",
  '-    <div className="capability">',
  '+    <div className="capability px-cut">',
].join("\n");

const DEMO_DIFF_TOKENS = [
  "diff --git a/frontend/src/theme/tokens.css b/frontend/src/theme/tokens.css",
  "@@ -8,5 +8,6 @@",
  " :root {",
  "   --px-bg: #eaf1e3;",
  "+  --px-accent: #3b82d6;",
  "   --px-ink: #263425;",
  " }",
].join("\n");

const DEMO_DIFF_CONFLICT = [
  "diff --git a/src/merge.rs b/src/merge.rs",
  "@@ -3,7 +3,11 @@ fn merge(task: &MergeTask) {",
  "<<<<<<< HEAD",
  "    backend.git_merge(task.order());",
  "=======",
  "    backend.git_merge(task.position_order());",
  ">>>>>>> feat/merge-task",
  "}",
].join("\n");

/**
 * Git 模块（假数据层）：仓库/分支/变更状态全部经 git.updated 事件投影。
 * 写锁来自 DeliveryModule 的 writer lease（PRD-RUN-001）；占用时写操作返回 409 语义。
 */
export class GitModule {
  private branches: GitBranch[] = [
    { name: "main", current: true, ahead: 1, behind: 0 },
    { name: "feat/canvas-polish", current: false, ahead: 3, behind: 1 },
    { name: "integration/demo", current: false, ahead: 0, behind: 2 },
  ];
  private changes: GitChange[] = [
    {
      path: "frontend/src/theme/tokens.css",
      status: "staged",
      diff: DEMO_DIFF_TOKENS,
    },
    {
      path: "frontend/src/canvas/nodes.tsx",
      status: "unstaged",
      diff: DEMO_DIFF_CANVAS,
    },
    { path: "docs/rewrite/TODO.md", status: "untracked", diff: null },
    { path: "src/merge.rs", status: "conflicted", diff: DEMO_DIFF_CONFLICT },
  ];
  private lastCommit: string | null = "c3d9e21 feat: 射线工作台与视口恢复";

  constructor(
    private readonly deps: {
      idPrefix: string;
      emit: Emit;
      latency: () => Promise<void>;
      /** writer lease：活动 Run（含 waiting_workspace）持锁 */
      writeLock: () => { locked: boolean; owner_run_id: string | null };
    },
  ) {}

  private state(): GitRepoState {
    return {
      root: "/Users/demo/raccoon-demo",
      branches: this.branches.map((branch) => ({ ...branch })),
      changes: this.changes.map((change) => ({ ...change })),
      write_lock: this.deps.writeLock(),
      last_commit: this.lastCommit,
    };
  }

  private publish() {
    this.deps.emit("git", "repo", "git.updated", { state: this.state() });
  }

  snapshotState(): GitRepoState {
    return this.state();
  }

  private locked(): boolean {
    return this.deps.writeLock().locked;
  }

  private async mutate(
    apply: () => { ok: boolean; message: string | null },
  ): Promise<{ ok: boolean; message: string | null }> {
    await this.deps.latency();
    if (this.locked()) return { ok: false, message: GIT_LOCKED_MESSAGE };
    const result = apply();
    if (result.ok) this.publish();
    return result;
  }

  stageChange(path: string) {
    return this.mutate(() => {
      const change = this.changes.find(
        (entry) => entry.path === path && entry.status === "unstaged",
      );
      if (!change)
        return { ok: false, message: `没有可暂存的未暂存变更：${path}` };
      change.status = "staged";
      return { ok: true, message: null };
    });
  }

  unstageChange(path: string) {
    return this.mutate(() => {
      const change = this.changes.find(
        (entry) => entry.path === path && entry.status === "staged",
      );
      if (!change)
        return { ok: false, message: `没有可取消暂存的变更：${path}` };
      change.status = "unstaged";
      return { ok: true, message: null };
    });
  }

  /** 危险命令处理器（confirm 阶段调用）；返回结果写入 WorkbenchAction.result */
  execute(
    kind: WorkbenchActionKind,
    payload: Record<string, string>,
  ): { ok: boolean; message: string } {
    if (this.locked()) return { ok: false, message: GIT_LOCKED_MESSAGE };
    const current = this.branches.find((branch) => branch.current);
    switch (kind) {
      case "git_commit": {
        const staged = this.changes.filter(
          (change) => change.status === "staged",
        );
        if (staged.length === 0) {
          return { ok: false, message: "没有已暂存的变更，提交未执行。" };
        }
        const message = payload.message?.trim() || "chore: 演示提交";
        this.changes = this.changes.filter(
          (change) => change.status !== "staged",
        );
        this.lastCommit = `f0e${Math.floor(Math.random() * 900 + 100)} ${message}`;
        if (current) current.ahead += 1;
        this.publish();
        return {
          ok: true,
          message: `已创建提交「${this.lastCommit}」（${staged.length} 个文件）。`,
        };
      }
      case "git_push": {
        if (!current || current.ahead === 0) {
          return { ok: false, message: "当前分支没有待推送提交。" };
        }
        current.ahead = 0;
        this.publish();
        return { ok: true, message: `已推送 ${current.name} 到 origin。` };
      }
      case "git_pull": {
        if (!current || current.behind === 0) {
          return { ok: false, message: "当前分支没有待拉取提交。" };
        }
        current.behind = 0;
        this.publish();
        return { ok: true, message: `已 fast-forward ${current.name}。` };
      }
      case "git_fetch": {
        this.publish();
        return { ok: true, message: "已 fetch origin（演示：无新对象）。" };
      }
      case "git_switch_branch": {
        const target = this.branches.find(
          (branch) => branch.name === payload.branch,
        );
        if (!target)
          return { ok: false, message: `分支不存在：${payload.branch}` };
        for (const branch of this.branches) branch.current = branch === target;
        this.publish();
        return { ok: true, message: `已切换到分支 ${target.name}。` };
      }
      case "git_create_branch": {
        const name = payload.branch?.trim();
        if (!name) return { ok: false, message: "分支名不能为空。" };
        if (this.branches.some((branch) => branch.name === name)) {
          return { ok: false, message: `分支已存在：${name}` };
        }
        this.branches = this.branches.map((branch) => ({
          ...branch,
          current: false,
        }));
        this.branches.push({ name, current: true, ahead: 0, behind: 0 });
        this.publish();
        return { ok: true, message: `已创建并切换到分支 ${name}。` };
      }
      case "git_discard": {
        const before = this.changes.length;
        this.changes = this.changes.filter(
          (change) =>
            !(change.path === payload.path && change.status !== "conflicted"),
        );
        if (this.changes.length === before) {
          return { ok: false, message: `没有可丢弃的变更：${payload.path}` };
        }
        this.publish();
        return { ok: true, message: `已丢弃 ${payload.path} 的工作区修改。` };
      }
      default:
        return { ok: false, message: `未知 Git 命令：${kind}` };
    }
  }

  summaryLines(): string[] {
    const current = this.branches.find((branch) => branch.current);
    const lock = this.deps.writeLock();
    return [
      `${current?.name ?? "—"} · 变更 ${this.changes.length}`,
      lock.locked ? `写锁占用：${lock.owner_run_id}` : "写锁空闲",
      `ahead ${current?.ahead ?? 0} / behind ${current?.behind ?? 0}`,
    ];
  }
}
