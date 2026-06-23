import { describe, expect, it } from "vitest";
import {
  getProjectViewportAction,
  getReactFlowKey,
  type ProjectViewportSnapshot,
} from "./App";

const start: ProjectViewportSnapshot = {
  currentCanvas: "start",
  projectLoaded: false,
  selectedDagRequirementId: null,
};

const project: ProjectViewportSnapshot = {
  currentCanvas: "project",
  projectLoaded: true,
  selectedDagRequirementId: null,
};

describe("project viewport action", () => {
  it("remounts React Flow when project canvas data becomes ready", () => {
    expect(
      getReactFlowKey({
        currentCanvas: "project",
        selectedProjectId: "project-1",
        projectLoaded: false,
      }),
    ).toBe("project-project-1-loading");
    expect(
      getReactFlowKey({
        currentCanvas: "project",
        selectedProjectId: "project-1",
        projectLoaded: true,
      }),
    ).toBe("project-project-1-ready");
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
