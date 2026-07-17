import { describe, expect, it } from "vitest";
import {
  deriveGrayDangoPresentation,
  GRAYDANGO_DRAG_ANIMATIONS,
  grayDangoDirectionCell,
} from "./graydangoModel";

describe("deriveGrayDangoPresentation", () => {
  it("rests without a bubble while idle and the queue is empty", () => {
    expect(
      deriveGrayDangoPresentation({ top: null, activity: { kind: "idle" } }),
    ).toMatchObject({ animation: "idle", row: 0, bubble: null });
  });

  it("surfaces action-required notifications as a waiting bubble", () => {
    expect(
      deriveGrayDangoPresentation({
        top: {
          severity: "action_required",
          message: "草案准备好了，等你确认",
        },
        activity: { kind: "idle" },
      }),
    ).toMatchObject({
      animation: "waiting",
      row: 6,
      bubble: "草案准备好了，等你确认",
      tone: "warning",
    });
  });

  it("uses the focused-work row while a tool is running", () => {
    expect(
      deriveGrayDangoPresentation({
        top: null,
        activity: { kind: "tool", name: "apply_patch" },
      }),
    ).toMatchObject({ animation: "running", row: 7, bubble: "apply_patch" });
  });

  it("uses the review row for review-like tools", () => {
    expect(
      deriveGrayDangoPresentation({
        top: null,
        activity: { kind: "tool", name: "review diff 审核" },
      }),
    ).toMatchObject({ animation: "review", row: 8 });
  });

  it("shows errors before any activity", () => {
    expect(
      deriveGrayDangoPresentation({
        top: { severity: "error", message: "连接失败" },
        activity: { kind: "thinking" },
      }),
    ).toMatchObject({
      animation: "failed",
      row: 5,
      bubble: "连接失败",
      tone: "error",
    });
  });

  it("celebrates success notifications", () => {
    expect(
      deriveGrayDangoPresentation({
        top: { severity: "success", message: "任务完成啦" },
        activity: { kind: "idle" },
      }),
    ).toMatchObject({ animation: "waving", row: 3, bubble: "任务完成啦" });
  });

  it("compacts long messages", () => {
    const long = "很长的错误 ".repeat(20);
    const result = deriveGrayDangoPresentation({
      top: { severity: "error", message: long },
      activity: { kind: "idle" },
    });
    expect(result.bubble).toHaveLength(53);
    expect(result.bubble).toMatch(/…$/);
  });
});

describe("grayDangoDirectionCell", () => {
  it.each([
    [0, -100, { row: 9, column: 0 }],
    [100, 0, { row: 9, column: 4 }],
    [0, 100, { row: 10, column: 0 }],
    [-100, 0, { row: 10, column: 4 }],
  ])("maps pointer vector (%s, %s) to the current atlas", (x, y, expected) => {
    expect(grayDangoDirectionCell(x, y, 10)).toEqual(expected);
  });

  it("uses idle inside the pointer deadzone", () => {
    expect(grayDangoDirectionCell(2, 2, 10)).toBeNull();
  });
});

describe("GrayDango drag animations", () => {
  it("uses the existing directional movement rows", () => {
    expect(GRAYDANGO_DRAG_ANIMATIONS).toEqual({
      right: { row: 1, frames: 8 },
      left: { row: 2, frames: 8 },
    });
  });
});
