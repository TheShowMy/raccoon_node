import { describe, expect, it } from "vitest";
import type {
  Notification,
  NotificationLifecycle,
  NotificationSeverity,
} from "../api/types";
import {
  isBlocking,
  readingDurationMs,
  selectNotificationQueue,
} from "./queue";

let counter = 0;
function makeNotification(
  severity: NotificationSeverity,
  options: {
    lifecycle?: NotificationLifecycle;
    raisedAt?: string;
    id?: string;
  } = {},
): Notification {
  counter += 1;
  const raised =
    options.raisedAt ??
    new Date(1_700_000_000_000 + counter * 1000).toISOString();
  return {
    id: options.id ?? `ntf-${counter}`,
    severity,
    message: `msg-${counter}`,
    source_workbench: "system",
    source_node_id: null,
    lifecycle: options.lifecycle ?? "active",
    raised_at: raised,
    acknowledged_at: null,
    resolved_at: null,
  };
}

describe("GrayDango 通知队列 selector（FE-PET-003/004/010）", () => {
  it("优先级：错误/待操作 → 警告 → 完成/信息；同级按 raised_at", () => {
    const info = makeNotification("info", { raisedAt: "2026-01-01T00:00:01Z" });
    const warning = makeNotification("warning", {
      raisedAt: "2026-01-01T00:00:02Z",
    });
    const error = makeNotification("error", {
      raisedAt: "2026-01-01T00:00:03Z",
    });
    const action = makeNotification("action_required", {
      raisedAt: "2026-01-01T00:00:00Z",
    });
    const success = makeNotification("success", {
      raisedAt: "2026-01-01T00:00:04Z",
    });
    const queue = selectNotificationQueue(
      Object.fromEntries(
        [info, warning, error, action, success].map((n) => [n.id, n]),
      ),
    );
    expect(queue.map((n) => n.id)).toEqual([
      action.id, // 同级按 raised_at：00 先于 03
      error.id,
      warning.id,
      info.id,
      success.id,
    ]);
  });

  it("resolved 离场；acknowledged 的阻断项保留可再次访问", () => {
    const resolvedError = makeNotification("error", { lifecycle: "resolved" });
    const ackError = makeNotification("error", { lifecycle: "acknowledged" });
    const ackWarning = makeNotification("warning", {
      lifecycle: "acknowledged",
    });
    const ackInfo = makeNotification("info", { lifecycle: "acknowledged" });
    const queue = selectNotificationQueue(
      Object.fromEntries(
        [resolvedError, ackError, ackWarning, ackInfo].map((n) => [n.id, n]),
      ),
    );
    expect(queue.map((n) => n.id)).toEqual([ackError.id]);
  });

  it("同 severity 下未确认排在已确认前", () => {
    const acked = makeNotification("error", {
      lifecycle: "acknowledged",
      raisedAt: "2026-01-01T00:00:00Z",
    });
    const active = makeNotification("error", {
      raisedAt: "2026-01-01T00:00:05Z",
    });
    const queue = selectNotificationQueue(
      Object.fromEntries([acked, active].map((n) => [n.id, n])),
    );
    expect(queue.map((n) => n.id)).toEqual([active.id, acked.id]);
  });

  it("isBlocking 仅错误与待操作", () => {
    expect(isBlocking(makeNotification("error"))).toBe(true);
    expect(isBlocking(makeNotification("action_required"))).toBe(true);
    expect(isBlocking(makeNotification("warning"))).toBe(false);
    expect(isBlocking(makeNotification("info"))).toBe(false);
  });

  it("阅读时长有上下界（FE-PET-004）", () => {
    expect(readingDurationMs("")).toBe(5000);
    expect(readingDurationMs("x".repeat(10))).toBeGreaterThan(5000);
    expect(readingDurationMs("x".repeat(1000))).toBe(15000);
  });
});
