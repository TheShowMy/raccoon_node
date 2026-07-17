import type { AppSettings } from "./types";

/**
 * 设置语义（FE-SET-002，纯函数）：
 * 部分设置保存后需重启才生效；保存和重启是两个动作。
 */

/** 保存后需要重启的键（监听地址/端口） */
export const RESTART_REQUIRED_KEYS = ["listen_host", "listen_port"] as const;

export type RestartRequiredKey = (typeof RESTART_REQUIRED_KEYS)[number];

/** 计算本次修改中需要重启才生效的键（与原值比较） */
export function settingsRequiringRestart(
  current: AppSettings,
  patch: Partial<AppSettings>,
): RestartRequiredKey[] {
  return RESTART_REQUIRED_KEYS.filter((key) => {
    const next = patch[key];
    return next !== undefined && next !== current[key];
  });
}

export const NETWORK_POLICY_LABELS: Record<
  AppSettings["network_policy"],
  string
> = {
  offline: "离线（默认）",
  package_registry: "仅包管理器",
  git_remote: "允许 Git 远端",
  readonly_fetch: "受控只读抓取",
};
