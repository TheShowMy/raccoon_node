import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRAYDANGO_POSITION,
  grayDangoDragDirection,
  grayDangoPositionForPointer,
  parseGrayDangoPosition,
} from "./graydangoPosition";

describe("GrayDango position", () => {
  it("loads valid normalized positions and rejects invalid storage", () => {
    expect(parseGrayDangoPosition('{"x":0.25,"y":0.75}')).toEqual({
      x: 0.25,
      y: 0.75,
    });
    expect(parseGrayDangoPosition(null)).toBe(DEFAULT_GRAYDANGO_POSITION);
    expect(parseGrayDangoPosition("invalid")).toBe(DEFAULT_GRAYDANGO_POSITION);
    expect(parseGrayDangoPosition('{"x":2,"y":0.5}')).toBe(
      DEFAULT_GRAYDANGO_POSITION,
    );
    expect(parseGrayDangoPosition('{"x":null,"y":0.5}')).toBe(
      DEFAULT_GRAYDANGO_POSITION,
    );
  });

  it("maps pointer coordinates into the available pet travel area", () => {
    const container = { left: 100, top: 50, width: 1000, height: 700 };
    const pet = { width: 200, height: 100 };
    const grabOffset = { x: 50, y: 25 };

    expect(
      grayDangoPositionForPointer(
        { x: 550, y: 375 },
        container,
        pet,
        grabOffset,
      ),
    ).toEqual({ x: 0.5, y: 0.5 });
    expect(
      grayDangoPositionForPointer(
        { x: -500, y: 5000 },
        container,
        pet,
        grabOffset,
      ),
    ).toEqual({ x: 0, y: 1 });
  });

  it("changes direction only after horizontal movement clears the deadzone", () => {
    expect(grayDangoDragDirection(-10, "right")).toBe("left");
    expect(grayDangoDragDirection(10, "left")).toBe("right");
    expect(grayDangoDragDirection(1, "left")).toBe("left");
    expect(grayDangoDragDirection(0, "right")).toBe("right");
  });
});
