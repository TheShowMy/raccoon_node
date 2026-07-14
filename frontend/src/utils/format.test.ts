import { describe, expect, it } from "vitest";
import {
  findingPriorityText,
  formatCompactNumber,
  formatDate,
  reviewAngleText,
  validationStatusText,
  workflowAttemptKindText,
  workflowAttemptStatusText,
  workflowEventLabel,
  workflowRunStatusText,
} from "../utils/format";

describe("format utilities", () => {
  it("formats ISO dates", () => {
    const date = new Date("2026-06-18T10:30:00Z").toISOString();
    expect(formatDate(date)).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
  });

  it("formats large numbers with Chinese units", () => {
    expect(formatCompactNumber(0)).toBe("0");
    expect(formatCompactNumber(9999)).toBe("9,999");
    expect(formatCompactNumber(10_000)).toBe("1.0万");
    expect(formatCompactNumber(2_814_061)).toBe("281.4万");
    expect(formatCompactNumber(34_009_232)).toBe("3400.9万");
    expect(formatCompactNumber(100_000_000)).toBe("1.0亿");
    expect(formatCompactNumber(150_000_000)).toBe("1.5亿");
  });

  it("translates workflow run statuses", () => {
    expect(workflowRunStatusText("running")).toBe("执行中");
    expect(workflowRunStatusText("blocked")).toBe("已阻塞");
    expect(workflowRunStatusText("rescuing")).toBe("深度修复中");
  });

  it("translates attempt kinds and statuses", () => {
    expect(workflowAttemptKindText("implementation")).toBe("实现");
    expect(workflowAttemptKindText("rescue")).toBe("深度修复");
    expect(workflowAttemptStatusText("succeeded")).toBe("成功");
    expect(workflowAttemptStatusText("superseded")).toBe("已降级");
  });

  it("translates review angles", () => {
    expect(reviewAngleText("correctness")).toBe("正确性");
    expect(reviewAngleText("security")).toBe("边界与安全");
  });

  it("translates validation statuses", () => {
    expect(validationStatusText("passed")).toBe("通过");
    expect(validationStatusText("failed")).toBe("失败");
    expect(validationStatusText("pending")).toBe("待执行");
  });

  it("translates finding priorities", () => {
    expect(findingPriorityText("P0")).toBe("P0 阻断");
    expect(findingPriorityText("P2")).toBe("P2 建议");
  });

  it("translates workflow event types", () => {
    expect(workflowEventLabel("validation.completed")).toBe("仓库检查完成");
    expect(workflowEventLabel("run.rescue_started")).toBe("启动深度修复");
    expect(workflowEventLabel("checkpoint.rejected")).toBe("审核发现阻断项");
    expect(workflowEventLabel("unknown.event")).toBe("unknown.event");
  });
});
