import { describe, expect, it } from "vitest";
import {
  countAdvisories,
  countBlockingFindings,
  qualitySummary,
} from "./quality";
import type { Run, RunReview, RunValidation } from "./types";

function run(partial: Partial<Run>): Run {
  return {
    id: "run-1",
    requirement_id: "req-1",
    requirement_revision: 1,
    phase: "terminal",
    resume_phase: null,
    outcome: null,
    blocked_reason: null,
    cancel_reason: null,
    current_activity: null,
    publication_path: "local",
    publication_frozen_reason: "",
    task_budget_usd: 25,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const validation = (overall: RunValidation["overall"]): RunValidation => ({
  run_id: "run-1",
  entries: [],
  overall,
});

const review = (partial: Partial<RunReview>): RunReview => ({
  run_id: "run-1",
  angles: [],
  overall: "approved",
  ...partial,
});

describe("质量结论组合文案（01 §8.2：禁止只显示「完成」）", () => {
  it("已交付 · 仅基线失败 · N 个 P2/P3 建议", () => {
    const text = qualitySummary({
      run: run({ outcome: "delivered" }),
      validation: validation("baseline_issues_only"),
      review: review({
        overall: "approved_with_advisories",
        angles: [
          {
            angle: "quality",
            verdict: "approved_with_advisories",
            rounds: 2,
            input_scope: "",
            findings: [
              {
                id: "F1",
                angle: "quality",
                priority: "P1",
                title: "",
                detail: "",
                resolved: true,
              },
              {
                id: "F2",
                angle: "quality",
                priority: "P2",
                title: "",
                detail: "",
                resolved: false,
              },
              {
                id: "F3",
                angle: "security",
                priority: "P3",
                title: "",
                detail: "",
                resolved: false,
              },
            ],
          },
        ],
      }),
    });
    expect(text).toBe("已交付 · 仅基线失败 · 2 个 P2/P3 建议");
  });

  it("干净交付与阻断交付分别组合", () => {
    expect(
      qualitySummary({
        run: run({ outcome: "delivered" }),
        validation: validation("clean"),
        review: review({ overall: "approved" }),
      }),
    ).toBe("已交付 · 验证干净 · 审核通过");
    expect(
      qualitySummary({
        run: run({ outcome: "blocked" }),
        validation: validation("new_regression"),
        review: null,
      }),
    ).toBe("已阻断 · 新增回归");
  });

  it("未经审核交付是独立事实", () => {
    expect(
      qualitySummary({
        run: run({ outcome: "delivered" }),
        validation: validation("clean"),
        review: review({ overall: "unavailable" }),
      }),
    ).toBe("已交付 · 验证干净 · 未经审核");
  });

  it("进行中的 Run 显示阶段而非结果", () => {
    expect(
      qualitySummary({
        run: run({ phase: "validating", outcome: null }),
        validation: null,
        review: null,
      }),
    ).toBe("验证中");
  });

  it("建议与阻断计数只统计未解决项", () => {
    const value = review({
      angles: [
        {
          angle: "quality",
          verdict: "blocking_findings",
          rounds: 1,
          input_scope: "",
          findings: [
            {
              id: "F1",
              angle: "quality",
              priority: "P0",
              title: "",
              detail: "",
              resolved: false,
            },
            {
              id: "F2",
              angle: "quality",
              priority: "P1",
              title: "",
              detail: "",
              resolved: true,
            },
          ],
        },
      ],
    });
    expect(countBlockingFindings(value)).toBe(1);
    expect(countAdvisories(value)).toBe(0);
  });
});
