import { describe, expect, it } from "vitest";
import { runNodeOffscreen } from "./DeliveryWorkbench";

/**
 * 悬浮「回到 Run」指示纯函数：可见性判定、8 方向箭头与边缘吸附。
 */
describe("runNodeOffscreen", () => {
  const pane = { width: 1000, height: 600 };
  const viewport = { x: 0, y: 0, zoom: 1 };

  it("pane 未测量时不显示", () => {
    expect(
      runNodeOffscreen({
        viewport,
        pane: { width: 0, height: 0 },
        node: { x: 2000, y: 0, width: 360, height: 320 },
      }),
    ).toBeNull();
  });

  it("节点完全可见或部分可见时不显示", () => {
    expect(
      runNodeOffscreen({
        viewport,
        pane,
        node: { x: 100, y: 100, width: 360, height: 320 },
      }),
    ).toBeNull();
    // 右缘部分可见
    expect(
      runNodeOffscreen({
        viewport,
        pane,
        node: { x: 900, y: 100, width: 360, height: 320 },
      }),
    ).toBeNull();
  });

  it("节点在右侧：箭头 →，吸附右缘", () => {
    const indicator = runNodeOffscreen({
      viewport,
      pane,
      node: { x: 2000, y: 200, width: 360, height: 320 },
    });
    expect(indicator).not.toBeNull();
    expect(indicator!.arrow).toBe("→");
    expect(indicator!.x).toBe(pane.width - 40);
    expect(indicator!.y).toBe(360);
  });

  it("节点在左侧：箭头 ←，吸附左缘", () => {
    const indicator = runNodeOffscreen({
      viewport,
      pane,
      node: { x: -800, y: 200, width: 360, height: 320 },
    });
    expect(indicator!.arrow).toBe("←");
    expect(indicator!.x).toBe(40);
  });

  it("节点在上方：箭头 ↑，吸附上缘", () => {
    const indicator = runNodeOffscreen({
      viewport,
      pane,
      node: { x: 300, y: -600, width: 360, height: 320 },
    });
    expect(indicator!.arrow).toBe("↑");
    expect(indicator!.y).toBe(40);
  });

  it("节点在下方：箭头 ↓，吸附下缘", () => {
    const indicator = runNodeOffscreen({
      viewport,
      pane,
      node: { x: 300, y: 1200, width: 360, height: 320 },
    });
    expect(indicator!.arrow).toBe("↓");
    expect(indicator!.y).toBe(pane.height - 40);
  });

  it("节点在左上对角：箭头 ↖，吸附角落", () => {
    const indicator = runNodeOffscreen({
      viewport,
      pane,
      node: { x: -800, y: -600, width: 360, height: 320 },
    });
    expect(indicator!.arrow).toBe("↖");
    expect(indicator!.x).toBe(40);
    expect(indicator!.y).toBe(40);
  });

  it("节点在右下对角：箭头 ↘", () => {
    const indicator = runNodeOffscreen({
      viewport,
      pane,
      node: { x: 2000, y: 1200, width: 360, height: 320 },
    });
    expect(indicator!.arrow).toBe("↘");
    expect(indicator!.x).toBe(pane.width - 40);
    expect(indicator!.y).toBe(pane.height - 40);
  });

  it("过渡中出现 NaN 时该帧隐藏", () => {
    expect(
      runNodeOffscreen({
        viewport: { x: Number.NaN, y: 0, zoom: 1 },
        pane,
        node: { x: 2000, y: 0, width: 360, height: 320 },
      }),
    ).toBeNull();
    expect(
      runNodeOffscreen({
        viewport,
        pane,
        node: { x: 2000, y: 0, width: Number.NaN, height: 320 },
      }),
    ).toBeNull();
  });

  it("viewport 平移参与可见性判定", () => {
    // 节点在 (2000, 200)，viewport 平移到它身上 → 可见
    expect(
      runNodeOffscreen({
        viewport: { x: -1700, y: -100, zoom: 1 },
        pane,
        node: { x: 2000, y: 200, width: 360, height: 320 },
      }),
    ).toBeNull();
  });
});
