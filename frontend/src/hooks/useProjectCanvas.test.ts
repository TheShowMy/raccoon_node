import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProjectCanvas,
  rerunReview,
  retryFailedNode,
  retryFromNode,
} from "../api/client";
import type {
  ProjectCanvasData,
  Requirement,
  RequirementStatus,
} from "../types/api";
import { useProjectCanvas } from "./useProjectCanvas";

vi.mock("../api/client", () => ({
  getProjectCanvas: vi.fn(),
  planRequirementExecution: vi.fn(),
  startRequirementExecution: vi.fn(),
  retryFailedNode: vi.fn(),
  retryFromNode: vi.fn(),
  rerunReview: vi.fn(),
}));

const project = {
  id: "project-1",
  name: "Raccoon",
  git_url: "https://example.com/raccoon.git",
  local_path: "/data/projects/project-1/repo",
  created_at: "2026-06-24T00:00:00Z",
  updated_at: "2026-06-24T00:00:00Z",
};

function createRequirement(
  status: RequirementStatus,
  title = "测试需求",
): Requirement {
  return {
    id: "requirement-1",
    project_id: project.id,
    title,
    original_message: "完成测试需求",
    status,
    messages: [],
    clarification_round: 0,
    clarifications: [],
    draft: null,
    execution_plan: null,
    pi_session_file: null,
    error: null,
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
  };
}

function createCanvas(requirement: Requirement): ProjectCanvasData {
  return {
    project,
    active_requirement: requirement,
    queued_requirements: [],
    completed_requirements: [],
  };
}

const initialRequirement = createRequirement("failed");
const initialCanvas = createCanvas(initialRequirement);

function renderProjectCanvas(setError = vi.fn()) {
  const setCurrentCanvas = vi.fn();
  const setSelectedProjectId = vi.fn();
  const result = renderHook(() =>
    useProjectCanvas(
      project.id,
      "project",
      setError,
      setCurrentCanvas,
      setSelectedProjectId,
    ),
  );
  return { ...result, setError };
}

describe("useProjectCanvas task recovery actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getProjectCanvas).mockResolvedValue(initialCanvas);
  });

  it.each([
    ["retryFailedNode", retryFailedNode],
    ["retryFromNode", retryFromNode],
    ["rerunReview", rerunReview],
  ] as const)(
    "%s 调用对应 API 并用返回值更新画布",
    async (actionName, apiAction) => {
      const updatedCanvas = createCanvas(
        createRequirement("running", `${actionName} 后的需求`),
      );
      vi.mocked(apiAction).mockResolvedValue(updatedCanvas);
      const { result } = renderProjectCanvas();

      await waitFor(() => {
        expect(result.current.projectCanvas).toBe(initialCanvas);
      });

      act(() => {
        result.current.selectDagRequirement(initialRequirement);
      });

      await act(async () => {
        await result.current[actionName]("requirement-1", "task-1");
      });

      expect(apiAction).toHaveBeenCalledTimes(1);
      expect(apiAction).toHaveBeenCalledWith("requirement-1", "task-1");
      expect(result.current.selectedDagRequirementId).toBe("requirement-1");
      expect(result.current.projectCanvas).toBe(updatedCanvas);
      expect(result.current.requirementActionBusyId).toBeNull();
      expect(result.current.requirementActionError).toBeNull();
    },
  );

  it("API 失败时保持画布和选中需求，并只设置操作错误", async () => {
    vi.mocked(retryFailedNode).mockRejectedValue(new Error("节点恢复失败"));
    const setError = vi.fn();
    const { result } = renderProjectCanvas(setError);

    await waitFor(() => {
      expect(result.current.projectCanvas).toBe(initialCanvas);
    });

    act(() => {
      result.current.selectDagRequirement(initialRequirement);
    });
    setError.mockClear();

    await act(async () => {
      await result.current.retryFailedNode("requirement-1", "task-1");
    });

    expect(retryFailedNode).toHaveBeenCalledTimes(1);
    expect(retryFailedNode).toHaveBeenCalledWith("requirement-1", "task-1");
    expect(result.current.projectCanvas).toBe(initialCanvas);
    expect(result.current.selectedDagRequirementId).toBe("requirement-1");
    expect(result.current.requirementActionError).toBe("节点恢复失败");
    expect(result.current.requirementActionBusyId).toBeNull();
    expect(setError).not.toHaveBeenCalled();
  });

  it("恢复请求期间设置 busy，完成后清空", async () => {
    let resolveAction!: (data: ProjectCanvasData) => void;
    vi.mocked(retryFromNode).mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    const { result } = renderProjectCanvas();

    await waitFor(() => {
      expect(result.current.projectCanvas).toBe(initialCanvas);
    });

    let recovery!: Promise<void>;
    act(() => {
      recovery = result.current.retryFromNode("requirement-1", "task-1");
    });
    expect(result.current.requirementActionBusyId).toBe("requirement-1");

    await act(async () => {
      resolveAction(initialCanvas);
      await recovery;
    });

    expect(result.current.requirementActionBusyId).toBeNull();
  });
});
