import { describe, expect, it } from "vitest";
import { getReactFlowKey } from "./App";

describe("project canvas key", () => {
  it("remounts React Flow when project canvas data becomes ready", () => {
    expect(
      getReactFlowKey({
        projectLoaded: false,
      }),
    ).toBe("project-loading");
    expect(
      getReactFlowKey({
        projectLoaded: true,
      }),
    ).toBe("project-ready");
  });
});
