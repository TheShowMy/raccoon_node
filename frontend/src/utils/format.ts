import type {
  DraftClarificationAnswer,
  FindingPriority,
  ModelSettings,
  ModelTierKey,
  RequirementClarification,
  RequirementStatus,
  ReviewAngle,
  ThinkingLevel,
  ValidationRunStatus,
  WorkflowAttemptKind,
  WorkflowAttemptStatus,
  WorkflowCleanupStatus,
  WorkflowLocalSyncStatus,
  WorkflowPublicationMode,
  WorkflowPublicationPhase,
  WorkflowPublicationProvider,
  WorkflowRunStatus,
} from "../types/api";

export const tierLabels: Record<ModelTierKey, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export const thinkingLevels: Array<{ value: ThinkingLevel; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function readError(reason: unknown) {
  return reason instanceof Error ? reason.message : "未知错误";
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  low: { model_id: null, thinking_level: "low" },
  medium: { model_id: null, thinking_level: "medium" },
  high: { model_id: null, thinking_level: "high" },
};

export function modelStatusText(
  status: "idle" | "loading" | "ready" | "reconnecting" | "error",
) {
  if (status === "loading") return "正在读取 Pi Agent 模型";
  if (status === "ready") return "Pi Agent RPC 已连接";
  if (status === "error") return "Pi Agent RPC 异常";
  if (status === "reconnecting") return "Pi Agent 重新连接中...";
  return "等待加载";
}

export function requirementStatusText(status: RequirementStatus) {
  const labels: Record<RequirementStatus, string> = {
    analyzing: "分析中",
    clarifying: "澄清中",
    draft_ready: "待确认",
    planning: "拆分任务中",
    queued: "等待执行",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
  };
  return labels[status];
}

const workflowRunStatusLabels: Record<WorkflowRunStatus, string> = {
  planning: "规划中",
  running: "执行中",
  validating: "验证中",
  reviewing: "审核中",
  fixing: "集成修复中",
  rescuing: "深度修复中",
  publishing: "发布中",
  paused_technical: "技术暂停",
  completed: "已完成",
  blocked: "已阻塞",
  cancelled: "已取消",
};

export function workflowRunStatusText(status: WorkflowRunStatus): string {
  return workflowRunStatusLabels[status] ?? status;
}

const workflowAttemptKindLabels: Record<WorkflowAttemptKind, string> = {
  implementation: "实现",
  fix: "修复",
  integration_fix: "集成修复",
  remote_ci_fix: "远端 CI 修复",
  rescue: "深度修复",
};

export function workflowAttemptKindText(kind: WorkflowAttemptKind): string {
  return workflowAttemptKindLabels[kind] ?? kind;
}

const workflowAttemptStatusLabels: Record<WorkflowAttemptStatus, string> = {
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  superseded: "已降级",
};

export function workflowAttemptStatusText(
  status: WorkflowAttemptStatus,
): string {
  return workflowAttemptStatusLabels[status] ?? status;
}

const reviewAngleLabels: Record<ReviewAngle, string> = {
  correctness: "正确性",
  quality: "代码质量与测试",
  security: "边界与安全",
};

export function reviewAngleText(angle: ReviewAngle): string {
  return reviewAngleLabels[angle] ?? angle;
}

const validationStatusLabels: Record<ValidationRunStatus, string> = {
  pending: "待执行",
  passed: "通过",
  failed: "失败",
  unavailable: "不可用",
};

export function validationStatusText(status: ValidationRunStatus): string {
  return validationStatusLabels[status] ?? status;
}

const findingPriorityLabels: Record<FindingPriority, string> = {
  P0: "P0 阻断",
  P1: "P1 高优",
  P2: "P2 建议",
  P3: "P3 提示",
};

export function findingPriorityText(priority: FindingPriority): string {
  return findingPriorityLabels[priority] ?? priority;
}

const workflowPublicationModeLabels: Record<WorkflowPublicationMode, string> = {
  local: "本地",
  pull_request: "Pull Request",
};

export function workflowPublicationModeText(
  mode: WorkflowPublicationMode,
): string {
  return workflowPublicationModeLabels[mode] ?? mode;
}

const workflowPublicationProviderLabels: Record<
  WorkflowPublicationProvider,
  string
> = {
  local: "本地",
  github: "GitHub",
  gitlab: "GitLab",
};

export function workflowPublicationProviderText(
  provider: WorkflowPublicationProvider,
): string {
  return workflowPublicationProviderLabels[provider] ?? provider;
}

const workflowPublicationPhaseLabels: Record<WorkflowPublicationPhase, string> =
  {
    prepared: "已准备",
    pushed: "已推送",
    review_open: "PR/MR 已创建",
    waiting_checks: "等待检查",
    merged: "已合并",
    cleaning: "清理中",
    completed: "已完成",
  };

export function workflowPublicationPhaseText(
  phase: WorkflowPublicationPhase,
): string {
  return workflowPublicationPhaseLabels[phase] ?? phase;
}

const workflowLocalSyncStatusLabels: Record<WorkflowLocalSyncStatus, string> = {
  pending: "待同步",
  synced: "已同步",
  skipped: "已跳过",
};

export function workflowLocalSyncStatusText(
  status: WorkflowLocalSyncStatus,
): string {
  return workflowLocalSyncStatusLabels[status] ?? status;
}

const workflowCleanupStatusLabels: Record<WorkflowCleanupStatus, string> = {
  pending: "待清理",
  running: "清理中",
  completed: "已完成",
  failed: "失败",
};

export function workflowCleanupStatusText(
  status: WorkflowCleanupStatus,
): string {
  return workflowCleanupStatusLabels[status] ?? status;
}

export function workflowEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    "run.created": "工作流已创建",
    "run.workspace_attached": "工作区准备完成",
    "run.resumed": "已从暂停恢复",
    "run.rescue_started": "启动深度修复",
    "run.rescuing": "继续深度修复",
    "run.publishing": "进入发布阶段",
    "run.paused_technical": "遇到技术问题暂停",
    "run.discarded": "已废弃当前运行",
    "run.restarted_clean": "已在干净环境重新执行",
    "run.completed": "工作流已完成",
    "run.blocked": "工作流已阻塞",
    "work_item.fix_requested": "行为切片需要修复",
    "attempt.started": "执行尝试开始",
    "attempt.succeeded": "执行尝试成功",
    "attempt.failed": "执行尝试失败",
    "attempt.superseded": "并行任务已降级",
    "attempt.usage_persisted": "用量记录已保存",
    "parallel_batch.serial_fallback": "并行任务改为串行",
    "parallel_batch.serial_fallback_exhausted": "串行降级已熔断",
    "workspace.boundary_blocked": "工作区越界已熔断",
    "integration.guard_failed": "集成守卫失败",
    "item_workspace.prepared": "隔离工作区已创建",
    "item_workspace.integrated": "工作项已汇入集成区",
    "item_workspace.cleaned": "工作项资源已清理",
    "publication.prepared": "发布配置已冻结",
    "publication.pushed": "工作流分支已推送",
    "publication.review_open": "远端 PR/MR 已创建",
    "publication.waiting_checks": "等待远端检查与合并",
    "publication.checks_changed": "远端检查状态变化",
    "publication.checks_failed": "远端检查失败",
    "publication.merged": "远端合并完成",
    "publication.local_sync_finished": "本地主分支同步处理完成",
    "publication.cleaning": "清理受管资源",
    "publication.cleanup_failed": "受管资源清理失败",
    "publication.completed": "发布与清理完成",
    "validation.completed": "仓库检查完成",
    "checkpoint.started": "最终审核启动",
    "checkpoint.review_observed": "审核结果已返回",
    "checkpoint.findings_recorded": "审核问题已记录",
    "checkpoint.approved": "审核通过",
    "checkpoint.rejected": "审核发现阻断项",
    "checkpoint.technical_failure": "审核技术失败",
  };
  return labels[eventType] ?? eventType;
}

export function buildClarificationAnswerPayload(
  clarification: RequirementClarification,
  answer: DraftClarificationAnswer,
) {
  return {
    clarification_id: clarification.id,
    selected_options:
      clarification.question_type === "free_text" ? [] : answer.selectedOptions,
    custom_text: answer.customText.trim() || null,
  };
}

export function formatCompactNumber(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return value.toLocaleString("zh-CN");
}
