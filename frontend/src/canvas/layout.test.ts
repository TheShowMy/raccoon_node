import { describe, expect, it } from "vitest";
import {
  CAPABILITY_KINDS,
  centralAreaRatio,
  computeMainLayout,
  sideColumnWidth,
} from "./layout";

describe("外层固定布局（FE-CANVAS-001/004/005）", () => {
  it("1440×900：中央对话图 ≥62% 宽 / ≥72% 高", () => {
    const ratio = centralAreaRatio({ width: 1440, height: 900 });
    expect(ratio.widthRatio).toBeGreaterThanOrEqual(0.62);
    expect(ratio.heightRatio).toBeGreaterThanOrEqual(0.72);
  });

  it("六个能力节点两列环绕，均在视口内且不压中央区", () => {
    const screen = { width: 1440, height: 900 };
    const layout = computeMainLayout(screen);
    expect(layout.capabilities).toHaveLength(6);
    expect(new Set(layout.capabilities.map((c) => c.kind))).toEqual(
      new Set(CAPABILITY_KINDS),
    );
    for (const cap of layout.capabilities) {
      expect(cap.x).toBeGreaterThanOrEqual(0);
      expect(cap.y).toBeGreaterThanOrEqual(0);
      expect(cap.x + cap.width).toBeLessThanOrEqual(screen.width);
      expect(cap.y + cap.height).toBeLessThanOrEqual(screen.height);
      // 不与中央区重叠
      const overlapX =
        cap.x < layout.central.x + layout.central.width &&
        cap.x + cap.width > layout.central.x;
      expect(overlapX).toBe(false);
    }
  });

  it("窗口变窄先压缩环绕区，中央区保持最小可操作尺寸", () => {
    const wide = computeMainLayout({ width: 1920, height: 1080 });
    const narrow = computeMainLayout({ width: 1024, height: 768 });
    expect(sideColumnWidth(1024)).toBeLessThan(sideColumnWidth(1920));
    expect(narrow.central.width).toBeGreaterThanOrEqual(480);
    expect(narrow.central.height).toBeGreaterThanOrEqual(420);
    // 宽屏下中央区随窗口增大
    expect(wide.central.width).toBeGreaterThan(narrow.central.width);
  });
});
