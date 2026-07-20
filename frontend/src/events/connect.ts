import type { EventEnvelope } from "../api/types";
import { createEventApplier } from "./applier";
import { createNdjsonDecoder } from "./ndjson";

export type EventConnectionState =
  "connecting" | "open" | "retrying" | "closed";

export type ConnectEventsOptions = {
  after: number;
  openStream: (after: number) => Promise<ReadableStream<Uint8Array>>;
  apply: (envelope: EventEnvelope) => void;
  reloadSnapshot: () => Promise<number>;
  onConnectionChange?: (state: EventConnectionState) => void;
  reconnectDelayMs?: number;
};

export type EventConnection = { close: () => void };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE_DELAY_MS = 1500;
const MAX_DELAY_MS = 30_000;

function backoff(attempt: number, base: number): number {
  return Math.min(base * 2 ** attempt, MAX_DELAY_MS);
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<typeof reader.read> {
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(new DOMException("Read timeout", "TimeoutError"));
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
}

export function connectEvents(options: ConnectEventsOptions): EventConnection {
  const reconnectDelayMs = options.reconnectDelayMs ?? BASE_DELAY_MS;
  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const releaseReader = () => {
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        // 锁可能已被释放
      }
      reader = null;
    }
  };

  const loop = async (initialAfter: number) => {
    let after = initialAfter;
    let retryCount = 0;
    while (!closed) {
      options.onConnectionChange?.("connecting");
      let resyncNeeded = false;
      try {
        const stream = await options.openStream(after);
        const applier = createEventApplier(after, {
          apply: options.apply,
          onResyncNeeded: () => {
            resyncNeeded = true;
            void reader?.cancel().catch(() => undefined);
          },
        });
        const decoder = createNdjsonDecoder({
          onLine: (line) => {
            let envelope: EventEnvelope;
            try {
              envelope = JSON.parse(line) as EventEnvelope;
            } catch {
              return;
            }
            applier.handle(envelope);
          },
        });
        reader = stream.getReader();
        options.onConnectionChange?.("open");
        retryCount = 0;
        const timeoutController = new AbortController();
        for (;;) {
          if (resyncNeeded) break;
          try {
            const { done, value } = await readWithTimeout(
              reader,
              timeoutController.signal,
            );
            if (done) break;
            if (value && value.byteLength > 0) decoder.write(value);
          } catch (err) {
            if (err instanceof DOMException && err.name === "TimeoutError") {
              break;
            }
            throw err;
          }
        }
        timeoutController.abort();
        decoder.flush();
        after = applier.expectedSequence - 1;
      } catch {
        options.onConnectionChange?.("retrying");
      } finally {
        releaseReader();
      }
      if (closed) break;
      if (resyncNeeded) {
        try {
          after = await options.reloadSnapshot();
          retryCount = 0;
        } catch {
          options.onConnectionChange?.("retrying");
          await sleep(backoff(retryCount, reconnectDelayMs));
          retryCount++;
        }
        continue;
      }
      options.onConnectionChange?.("retrying");
      await sleep(backoff(retryCount, reconnectDelayMs));
      retryCount++;
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
