import { describe, expect, it } from "vitest";
import { getVisibleSettingsViewport } from "./settingsViewport";

const canvas = { width: 1000, height: 800 };
const viewport = { x: 0, y: 0, zoom: 2 };

describe("settings viewport", () => {
  it("does not move a visible node", () => {
    expect(
      getVisibleSettingsViewport(
        viewport,
        canvas,
        { x: 100, y: 100, width: 100, height: 100 },
        24,
      ),
    ).toBe(viewport);
  });

  it.each([
    ["left", { x: -20, y: 100, width: 50, height: 50 }, { x: 64, y: 0 }],
    ["right", { x: 480, y: 100, width: 50, height: 50 }, { x: -84, y: 0 }],
    ["top", { x: 100, y: -20, width: 50, height: 50 }, { x: 0, y: 64 }],
    ["bottom", { x: 100, y: 380, width: 50, height: 50 }, { x: 0, y: -84 }],
  ])("minimally moves a node beyond the %s edge", (_, target, expected) => {
    expect(getVisibleSettingsViewport(viewport, canvas, target, 24)).toEqual({
      ...expected,
      zoom: 2,
    });
  });

  it("centers axes where the node is larger than the visible area", () => {
    expect(
      getVisibleSettingsViewport(
        viewport,
        canvas,
        { x: 100, y: 50, width: 600, height: 500 },
        24,
      ),
    ).toEqual({ x: -300, y: -200, zoom: 2 });
  });

  it("keeps the current zoom when moving", () => {
    expect(
      getVisibleSettingsViewport({ x: 10, y: 20, zoom: 1.5 }, canvas, {
        x: 700,
        y: 600,
        width: 100,
        height: 100,
      }).zoom,
    ).toBe(1.5);
  });

  it("supports a wider horizontal safety area for canvas overlays", () => {
    expect(
      getVisibleSettingsViewport(
        { x: 0, y: 0, zoom: 1 },
        { width: 1000, height: 700 },
        { x: 0, y: 100, width: 300, height: 400 },
        { horizontal: 230, vertical: 24 },
      ),
    ).toEqual({ x: 230, y: 0, zoom: 1 });
  });
});
