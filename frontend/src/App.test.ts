import { describe, expect, it } from "vitest";
import {
  getProjectViewportAction,
  getReactFlowKey,
  updateSettingsViewportStack,
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

describe("settings viewport stack", () => {
  it("restores each saved viewport while closing settings layers", () => {
    const initial = { x: 10, y: 20, zoom: 0.8 };
    const list = { x: 100, y: 120, zoom: 0.8 };
    const stack: (typeof initial)[] = [];

    expect(
      updateSettingsViewportStack("closed", "list", stack, initial),
    ).toBeUndefined();
    expect(
      updateSettingsViewportStack("list", "basic", stack, list),
    ).toBeUndefined();
    expect(updateSettingsViewportStack("basic", "list", stack, list)).toBe(
      list,
    );
    expect(updateSettingsViewportStack("list", "closed", stack, initial)).toBe(
      initial,
    );
    expect(stack).toEqual([]);
  });

  it("does not change the stack when switching detail nodes", () => {
    const viewport = { x: 10, y: 20, zoom: 1 };
    const stack = [{ x: 1, y: 2, zoom: 1 }];

    expect(
      updateSettingsViewportStack("basic", "models", stack, viewport),
    ).toBeUndefined();
    expect(stack).toEqual([{ x: 1, y: 2, zoom: 1 }]);
  });
});
