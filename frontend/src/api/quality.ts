import type {
  Run,
  RunReview,
  RunValidation,
  VerificationVerdict,
} from "./types";

/**
 * 质量结论组合文案（01 §8.2、FE-RUN 组合表达，纯函数）：
 * 状态、验证与审核是不同事实，禁止统一翻译为"成功/失败"。
 */

export const RUN_PHASE_LABELS: Record<Run["phase"], string> = {
  queued: "排队中",
  waiting_workspace: "等待工作区",
  planning: "规划中",
  executing: "执行中",
  validating: "验证中",
  reviewing: "审核中",
  publishing: "发布中",
  pausing: "暂停中",
  paused: "已暂停",
  blocked: "已阻断",
  terminal: "已结束",
};

export const RUN_OUTCOME_LABELS: Record<NonNullable<Run["outcome"]>, string> = {
  delivered: "已交付",
  blocked: "已阻断",
  cancelled: "已取消",
  failed: "失败",
};

export const VERIFICATION_VERDICT_LABELS: Record<VerificationVerdict, string> =
  {
    clean: "验证干净",
    baseline_issues_only: "仅基线失败",
    new_regression: "新增回归",
    unavailable: "验证不可用",
  };

export const REVIEW_VERDICT_LABELS = {
  approved: "审核通过",
  approved_with_advisories: "审核通过（含建议）",
  blocking_findings: "审核阻断",
  unavailable: "未经审核",
} as const;

/** 未解决的 P2/P3 建议数（交付后仍可见，PRD-QUAL-005） */
export function countAdvisories(review: RunReview | null): number {
  if (!review) return 0;
  return review.angles
    .flatMap((angle) => angle.findings)
    .filter(
      (finding) =>
        !finding.resolved &&
        (finding.priority === "P2" || finding.priority === "P3"),
    ).length;
}

/** 未解决的 P0/P1 阻断发现数 */
export function countBlockingFindings(review: RunReview | null): number {
  if (!review) return 0;
  return review.angles
    .flatMap((angle) => angle.findings)
    .filter(
      (finding) =>
        !finding.resolved &&
        (finding.priority === "P0" || finding.priority === "P1"),
    ).length;
}

/**
 * 组合表达，例如"已交付 · 仅基线失败 · 2 个 P2 建议"
 * （01 §8.2：界面必须组合表达，禁止只显示"完成"）。
 */
export function qualitySummary(input: {
  run: Run;
  validation: RunValidation | null;
  review: RunReview | null;
}): string {
  const parts: string[] = [];
  const { run, validation, review } = input;
  parts.push(
    run.outcome ? RUN_OUTCOME_LABELS[run.outcome] : RUN_PHASE_LABELS[run.phase],
  );
  if (run.phase !== "queued" && run.phase !== "waiting_workspace") {
    if (validation) {
      parts.push(VERIFICATION_VERDICT_LABELS[validation.overall]);
    }
    if (review) {
      if (review.overall === "unavailable") {
        parts.push(REVIEW_VERDICT_LABELS.unavailable);
      } else {
        const blocking = countBlockingFindings(review);
        const advisories = countAdvisories(review);
        if (blocking > 0) parts.push(`${blocking} 个 P0/P1 阻断`);
        if (advisories > 0) parts.push(`${advisories} 个 P2/P3 建议`);
        if (blocking === 0 && advisories === 0) {
          parts.push(REVIEW_VERDICT_LABELS.approved);
        }
      }
    }
  }
  return parts.join(" · ");
}
