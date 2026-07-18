import type { EventEnvelope } from "../api/types";
import { createEventApplier } from "./applier";
import { createNdjsonDecoder } from "./ndjson";

export type EventConnectionState =
  "connecting" | "open" | "retrying" | "closed";

export type ConnectEventsOptions = {
  after: number;
  /** 生产形态：fetch(`/api/v1/events?after=${after}`) 的 body（FE-EVENT-001/005） */
  openStream: (after: number) => Promise<ReadableStream<Uint8Array>>;
  apply: (envelope: EventEnvelope) => void;
  /** 缺口 / resync_required / 版本不兼容：重新加载快照，返回新的 last_sequence（FE-EVENT-006） */
  reloadSnapshot: () => Promise<number>;
  onConnectionChange?: (state: EventConnectionState) => void;
  reconnectDelayMs?: number;
};

export type EventConnection = { close: () => void };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 事件流连接状态机：断线保留当前只读投影并重连（FE-EVENT-005）；
 * 对账失败先 reload 快照再以新 last_sequence 重连。
 */
export function connectEvents(options: ConnectEventsOptions): EventConnection {
  const reconnectDelayMs = options.reconnectDelayMs ?? 1500;
  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const loop = async (initialAfter: number) => {
    let after = initialAfter;
    while (!closed) {
      options.onConnectionChange?.("connecting");
      let resyncNeeded = false;
      try {
        const stream = await options.openStream(after);
        const applier = createEventApplier(after, {
          apply: options.apply,
          onResyncNeeded: () => {
            resyncNeeded = true;
            // 取消挂起的 read，尽快进入 resync 流程
            void reader?.cancel().catch(() => undefined);
          },
        });
        const decoder = createNdjsonDecoder({
          onLine: (line) => {
            let envelope: EventEnvelope;
            try {
              envelope = JSON.parse(line) as EventEnvelope;
            } catch {
              return; // 单行损坏不致命：sequence 缺口会触发 resync
            }
            applier.handle(envelope);
          },
        });
        reader = stream.getReader();
        options.onConnectionChange?.("open");
        for (;;) {
          const { done, value } = await reader.read();
          if (done || resyncNeeded) break;
          if (value && value.byteLength > 0) decoder.write(value);
        }
        decoder.flush();
        // 断线重连从最后已应用 sequence 建立新请求（FE-EVENT-005），
        // 否则对端会重放已应用事件（delta 重复追加）
        after = applier.expectedSequence - 1;
      } catch {
        options.onConnectionChange?.("retrying");
      } finally {
        reader?.releaseLock();
        reader = null;
      }
      if (closed) break;
      if (resyncNeeded) {
        try {
          after = await options.reloadSnapshot();
        } catch {
          options.onConnectionChange?.("retrying");
          await sleep(reconnectDelayMs);
        }
        continue;
      }
      // 对端正常关闭：从最后已应用 sequence 重连
      options.onConnectionChange?.("retrying");
      await sleep(reconnectDelayMs);
    }
    options.onConnectionChange?.("closed");
  };

  void loop(options.after);
  return {
    close() {
      closed = true;
      void reader?.cancel().catch(() => undefined);
    },
  };
}
