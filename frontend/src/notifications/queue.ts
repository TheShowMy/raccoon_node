import type { Notification, NotificationSeverity } from "../api/types";

/**
 * GrayDango 通知队列 selector（FE-PET-003/004/010，纯函数）：
 * 优先级 错误/待操作 → 警告 → 完成/信息；同级按 raised_at；
 * acknowledged 的阻断项保留可再次访问，resolved 离场。
 */
export function severityRank(severity: NotificationSeverity): number {
  switch (severity) {
    case "error":
    case "action_required":
      return 0;
    case "warning":
      return 1;
    default:
      return 2;
  }
}

export function isBlocking(notification: Notification): boolean {
  return (
    notification.severity === "error" ||
    notification.severity === "action_required"
  );
}

export function selectNotificationQueue(
  notifications: Record<string, Notification>,
): Notification[] {
  return Object.values(notifications)
    .filter(
      (notification) =>
        notification.lifecycle === "active" ||
        (notification.lifecycle === "acknowledged" && isBlocking(notification)),
    )
    .sort((a, b) => {
      const rank = severityRank(a.severity) - severityRank(b.severity);
      if (rank !== 0) return rank;
      // 未确认优先于已确认（已确认不等于问题解除，FE-PET-010）
      const lifecycle =
        (a.lifecycle === "active" ? 0 : 1) - (b.lifecycle === "active" ? 0 : 1);
      if (lifecycle !== 0) return lifecycle;
      return a.raised_at.localeCompare(b.raised_at);
    });
}

/** 可访问阅读时长（FE-PET-004）：基础 5s + 每字符 120ms，上限 15s */
export function readingDurationMs(message: string): number {
  return Math.min(15_000, Math.max(5_000, 5_000 + message.length * 120));
}
