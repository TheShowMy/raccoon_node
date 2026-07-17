import type { GitChange, GitChangeStatus } from "./types";

/** Git 变更分组（FE-GIT-002，纯函数）：staged / unstaged / untracked / conflicted */

export const CHANGE_STATUS_ORDER: GitChangeStatus[] = [
  "conflicted",
  "staged",
  "unstaged",
  "untracked",
];

export const CHANGE_STATUS_LABELS: Record<GitChangeStatus, string> = {
  conflicted: "冲突",
  staged: "已暂存",
  unstaged: "未暂存",
  untracked: "未跟踪",
};

export type ChangeGroup = {
  status: GitChangeStatus;
  label: string;
  changes: GitChange[];
};

export function groupChanges(changes: GitChange[]): ChangeGroup[] {
  return CHANGE_STATUS_ORDER.map((status) => ({
    status,
    label: CHANGE_STATUS_LABELS[status],
    changes: changes
      .filter((change) => change.status === status)
      .sort((a, b) => a.path.localeCompare(b.path)),
  })).filter((group) => group.changes.length > 0);
}

/** 写锁语义（PRD-RUN-001）：写锁占用时 Git 写操作返回 409 语义 */
export const GIT_LOCKED_MESSAGE =
  "409：仓库写锁被活动 Run 占用（writer lease），Git 写操作暂不可用。";
