import type { EventConnection } from "../events/connect";
import { connectEvents } from "../events/connect";
import { getApi } from "./index";
import { useDomainStore } from "../store/domainStore";

/**
 * 启动引导（02 §9.1）：加载快照 → 初始化领域投影 → 按 last_sequence 连接事件流。
 * StrictMode 双挂载与多次调用安全（模块级幂等）。
 */
let bootPromise: Promise<void> | null = null;
let connection: EventConnection | null = null;

async function boot(): Promise<void> {
  const api = getApi();
  const snapshot = await api.getSnapshot();
  useDomainStore.getState().initFromSnapshot(snapshot);
  connection = connectEvents({
    after: snapshot.last_sequence,
    openStream: (after) => api.openEventStream(after),
    apply: (envelope) => useDomainStore.getState().applyEvent(envelope),
    reloadSnapshot: async () => {
      const fresh = await api.getSnapshot();
      useDomainStore.getState().initFromSnapshot(fresh);
      return fresh.last_sequence;
    },
    onConnectionChange: (state) =>
      useDomainStore.getState().setConnection(state),
  });
}

export function bootstrapDomain(): Promise<void> {
  bootPromise ??= boot().catch((error) => {
    // 失败后允许重试（首屏快照失败应可重试，02 §11）
    bootPromise = null;
    throw error;
  });
  return bootPromise;
}

/** 测试专用：重置引导状态 */
export function resetBootstrapForTest() {
  connection?.close();
  connection = null;
  bootPromise = null;
}
