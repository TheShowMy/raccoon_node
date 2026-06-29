import { describe, expect, it } from "vitest";
import {
  getProjectViewportAction,
  getReactFlowKey,
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
