import type { EventConnection } from "../events/connect";
import { connectEvents } from "../events/connect";
import { getApi } from "./index";
import { useDomainStore } from "../store/domainStore";

const BOOTSTRAP_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`操作超时（${ms / 1000}秒）`);
    }),
  ]);
}

export function bootstrapDomain(): Promise<void> {
  bootPromise ??= withTimeout(boot(), BOOTSTRAP_TIMEOUT_MS).catch((error) => {
    connection?.close();
    connection = null;
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
