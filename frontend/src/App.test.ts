import { describe, expect, it } from "vitest";
import {
  getProjectViewportAction,
  getReactFlowKey,
  getRequirementsReturnDirection,
  getSettingsViewportAction,
  getTerminalViewportAction,
  type ProjectViewportSnapshot,
} from "./App";

const start: ProjectViewportSnapshot = {
  projectLoaded: false,
  selectedDagRequirementId: null,
};

const project: ProjectViewportSnapshot = {
  projectLoaded: true,
  selectedDagRequirementId: null,
};

describe("project viewport action", () => {
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
    expect(getProjectViewportAction(start, project)).toBeNull();
  });

  it("focuses the DAG when a requirement DAG opens", () => {
    expect(
      getProjectViewportAction(project, {
        ...project,
        selectedDagRequirementId: "req-1",
      }),
    ).toBe("focus-dag");
  });

  it("fits when closing DAG and ignores unchanged project updates", () => {
    const dagOpen = { ...project, selectedDagRequirementId: "req-1" };

    expect(getProjectViewportAction(dagOpen, project)).toBe("fit");
    expect(getProjectViewportAction(project, project)).toBeNull();
    expect(getProjectViewportAction(dagOpen, dagOpen)).toBeNull();
  });
});

describe("terminal viewport action", () => {
  it("focuses on expand, restores on collapse, and ignores unchanged state", () => {
    expect(getTerminalViewportAction(true, false)).toBe("focus");
    expect(getTerminalViewportAction(false, true)).toBe("restore");
    expect(getTerminalViewportAction(true, true)).toBeNull();
  });
});

describe("settings viewport action", () => {
  it("focuses on expand, restores on collapse, and ignores unchanged state", () => {
    expect(getSettingsViewportAction(false, true)).toBe("focus");
    expect(getSettingsViewportAction(true, false)).toBe("restore");
    expect(getSettingsViewportAction(false, false)).toBeNull();
  });
});

describe("requirements return direction", () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };

  it("hides while visible and points toward an offscreen requirements area", () => {
    expect(
      getRequirementsReturnDirection(
        [rect],
        { x: 10, y: 10, zoom: 1 },
        800,
        600,
      ),
    ).toBeNull();
    expect(
      getRequirementsReturnDirection(
        [rect],
        { x: -500, y: 200, zoom: 1 },
        800,
        600,
      ),
    ).toBe("left");
    expect(
      getRequirementsReturnDirection(
        [rect],
        { x: 1000, y: 200, zoom: 1 },
        800,
        600,
      ),
    ).toBe("right");
    expect(
      getRequirementsReturnDirection(
        [rect],
        { x: 200, y: -500, zoom: 1 },
        800,
        600,
      ),
    ).toBe("up");
    expect(
      getRequirementsReturnDirection(
        [rect],
        { x: 200, y: 800, zoom: 1 },
        800,
        600,
      ),
    ).toBe("down");
  });
});
