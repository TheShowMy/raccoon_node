import type { ScenarioCommand, ScenarioState } from "../client";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 规格语义修改等导致的 Run 取消：导演脚本在下一检查点抛出并收尾（PRD-SPEC-007） */
export class RunCancelled extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RunCancelled";
  }
}

/**
 * 演示导演（假数据层）：驱动 Run 脚本按检查点推进。
 * - autoplay：每个检查点固定延迟（默认 ~2.4s，完整演示约 60–90 秒）；
 * - 手动模式：检查点挂起，控制台 step 逐一推进；
 * - 分支 flag：新回归 / 审核不可用 / 脏工作区 / rescue / CI 失败与拒绝合并；
 * - 阻断决策：blocked 后挂起，由 重试 / 放弃（确认链）/ 强制交付（确认链）解除。
 */
export class DemoDirector {
  private state: ScenarioState = {
    autoplay: true,
    step_delay_ms: 2400,
    flags: {
      remote_ready: true,
      dirty_workspace: false,
      new_regression: false,
      review_unavailable: false,
      rescue_demo: false,
      ci_fail_once: true,
      local_sync_fail: false,
      ci_reject: false,
    },
    awaiting_step_run_id: null,
  };

  private stepWaiter: (() => void) | null = null;
  private readonly waiters = new Map<string, (value: string) => void>();
  private readonly decisions = new Map<string, string>();
  private readonly cancelReasons = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  getState(): ScenarioState {
    return {
      ...this.state,
      flags: { ...this.state.flags },
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  command(input: ScenarioCommand): ScenarioState {
    if (input.type === "set_autoplay") {
      this.state.autoplay = input.value;
      // 切回自动播放：释放挂起的手动检查点，让脚本继续
      if (input.value) this.releaseStep();
    } else if (input.type === "step") {
      this.releaseStep();
    } else if (input.type === "set_step_delay") {
      this.state.step_delay_ms = Math.max(0, input.value);
    } else {
      this.state.flags[input.flag] = input.value;
    }
    this.notify();
    return this.getState();
  }

  flag(name: keyof ScenarioState["flags"]): boolean {
    return this.state.flags[name];
  }

  private releaseStep() {
    const waiter = this.stepWaiter;
    this.stepWaiter = null;
    waiter?.();
  }

  isCancelled(runId: string): boolean {
    return this.cancelReasons.has(runId);
  }

  throwIfCancelled(runId: string) {
    const reason = this.cancelReasons.get(runId);
    if (reason !== undefined) throw new RunCancelled(reason);
  }

  /** 检查点：自动播放延迟 / 手动模式挂起；取消在检查点边界生效 */
  async gate(runId: string, _label: string): Promise<void> {
    this.throwIfCancelled(runId);
    if (this.state.autoplay) {
      await sleep(this.state.step_delay_ms);
      this.throwIfCancelled(runId);
      return;
    }
    this.state.awaiting_step_run_id = runId;
    this.notify();
    await new Promise<void>((resolve) => {
      this.stepWaiter = resolve;
    });
    this.state.awaiting_step_run_id = null;
    this.notify();
    this.throwIfCancelled(runId);
  }

  /** 具名决策等待：blocked 重试/放弃/强制交付、暂停恢复、脏工作区解除、写锁 */
  async waitDecision<T extends string>(runId: string, key: string): Promise<T> {
    this.throwIfCancelled(runId);
    const fullKey = `${key}:${runId}`;
    await new Promise<string>((resolve) => {
      this.waiters.set(fullKey, resolve);
    });
    this.throwIfCancelled(runId);
    return this.decisions.get(fullKey) as T;
  }

  decide(runId: string, key: string, value: string) {
    const fullKey = `${key}:${runId}`;
    const waiter = this.waiters.get(fullKey);
    if (!waiter) return;
    this.waiters.delete(fullKey);
    this.decisions.set(fullKey, value);
    waiter(value);
  }

  /** 按前缀解除全部等待（如脏工作区 flag 关闭 → 所有 waiting_workspace 继续） */
  decideAll(key: string, value: string) {
    for (const [fullKey, waiter] of [...this.waiters.entries()]) {
      if (!fullKey.startsWith(`${key}:`)) continue;
      this.waiters.delete(fullKey);
      this.decisions.set(fullKey, value);
      waiter(value);
    }
  }

  /** 取消 Run：解除其全部挂起，脚本在下一检查点抛 RunCancelled */
  requestCancel(runId: string, reason: string) {
    this.cancelReasons.set(runId, reason);
    for (const [fullKey, waiter] of [...this.waiters.entries()]) {
      if (!fullKey.endsWith(`:${runId}`)) continue;
      this.waiters.delete(fullKey);
      waiter("cancelled");
    }
    if (this.state.awaiting_step_run_id === runId) this.releaseStep();
  }
}
