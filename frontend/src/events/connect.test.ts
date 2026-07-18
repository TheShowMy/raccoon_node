import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../api/types";
import { connectEvents, type EventConnectionState } from "./connect";

const encoder = new TextEncoder();

function envelope(
  sequence: number,
  eventType = "notification.resolved",
): EventEnvelope {
  return {
    schema_version: 1,
    sequence,
    event_id: `e-${sequence}`,
    occurred_at: "2026-01-01T00:00:00Z",
    aggregate_type: "system",
    aggregate_id: "sys",
    event_type: eventType as EventEnvelope["event_type"],
    payload: { notification_id: "n", resolved_at: "now" },
  };
}

/** 发送给定事件后立即关闭（模拟对端正常断开） */
function closingStream(envelopes: EventEnvelope[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const item of envelopes) {
        controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`));
      }
      controller.close();
    },
  });
}

/** 永不关闭的流（保持连接，等待调用方 close） */
function openStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: () => undefined });
}

async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor 超时：连接状态机未到达预期状态");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("事件流连接状态机（FE-EVENT-005/006）", () => {
  it("对端正常关闭后从最后已应用 sequence 重连，已应用投影保留", async () => {
    const opens: number[] = [];
    const applied: number[] = [];
    const states: EventConnectionState[] = [];
    const connection = connectEvents({
      after: 0,
      reconnectDelayMs: 1,
      openStream: (after) => {
        opens.push(after);
        // 第二次起保持连接，避免测试期间无限重连
        return Promise.resolve(
          opens.length === 1
            ? closingStream([envelope(1), envelope(2)])
            : openStream(),
        );
      },
      apply: (item) => applied.push(item.sequence),
      reloadSnapshot: () => Promise.resolve(0),
      onConnectionChange: (state) => states.push(state),
    });
    await waitFor(() => opens.length >= 2);
    connection.close();
    // 重连携带最后已应用 sequence 2，而不是初始 after=0（不重放、投影不清空）
    expect(opens).toEqual([0, 2]);
    expect(applied).toEqual([1, 2]);
    expect(states).toContain("open");
    expect(states).toContain("retrying");
  });

  it("序号缺口：停应用、重载快照，再以新 last_sequence 重连", async () => {
    const opens: number[] = [];
    const applied: number[] = [];
    let reloads = 0;
    const connection = connectEvents({
      after: 0,
      reconnectDelayMs: 1,
      openStream: (after) => {
        opens.push(after);
        return Promise.resolve(
          opens.length === 1
            ? closingStream([envelope(1), envelope(3)]) // 缺 2
            : openStream(),
        );
      },
      apply: (item) => applied.push(item.sequence),
      reloadSnapshot: () => {
        reloads += 1;
        return Promise.resolve(42);
      },
    });
    await waitFor(() => opens.length >= 2);
    connection.close();
    // 缺口后不重放 3：等快照重载后以 42 续传
    expect(applied).toEqual([1]);
    expect(reloads).toBe(1);
    expect(opens).toEqual([0, 42]);
  });

  it("system.resync_required：关闭 reader、重载快照、以新序号重连", async () => {
    const opens: number[] = [];
    let reloads = 0;
    const connection = connectEvents({
      after: 5,
      reconnectDelayMs: 1,
      openStream: (after) => {
        opens.push(after);
        return Promise.resolve(
          opens.length === 1
            ? closingStream([envelope(6, "system.resync_required")])
            : openStream(),
        );
      },
      apply: () => undefined,
      reloadSnapshot: () => {
        reloads += 1;
        return Promise.resolve(77);
      },
    });
    await waitFor(() => opens.length >= 2);
    connection.close();
    expect(reloads).toBe(1);
    expect(opens).toEqual([5, 77]);
  });

  it("openStream 拒绝：进入 retrying 并按延迟重试", async () => {
    let attempts = 0;
    const states: EventConnectionState[] = [];
    const connection = connectEvents({
      after: 0,
      reconnectDelayMs: 1,
      openStream: () => {
        attempts += 1;
        return attempts < 3
          ? Promise.reject(new Error("网络不可达"))
          : Promise.resolve(openStream());
      },
      apply: () => undefined,
      reloadSnapshot: () => Promise.resolve(0),
      onConnectionChange: (state) => states.push(state),
    });
    await waitFor(() => attempts >= 3);
    connection.close();
    // 两次失败各自至少进入一次 retrying，最终恢复 open
    expect(
      states.filter((state) => state === "retrying").length,
    ).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1]).toBe("open");
  });

  it("close 后进入 closed 且不再发起重连", async () => {
    let opens = 0;
    const states: EventConnectionState[] = [];
    const connection = connectEvents({
      after: 0,
      reconnectDelayMs: 1,
      openStream: () => {
        opens += 1;
        return Promise.resolve(openStream());
      },
      apply: () => undefined,
      reloadSnapshot: () => Promise.resolve(0),
      onConnectionChange: (state) => states.push(state),
    });
    await waitFor(() => opens >= 1);
    connection.close();
    await waitFor(() => states[states.length - 1] === "closed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opens).toBe(1);
  });
});
