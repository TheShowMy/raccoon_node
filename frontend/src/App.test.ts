import { describe, expect, it } from "vitest";
import { getReactFlowKey } from "./App";

describe("project canvas key", () => {
  it("remounts React Flow when project canvas data becomes ready", () => {
    expect(
      getReactFlowKey({
        projectId: "current",
        projectLoaded: false,
      }),
    ).toBe("project-current-loading");
    expect(
      getReactFlowKey({
        projectId: "current",
        projectLoaded: true,
      }),
    ).toBe("project-current-ready");
  });
});
