import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectCanvas, recoverTaskGroup } from "../api/client";
import type {
  ProjectCanvasData,
  Requirement,
  RequirementStatus,
} from "../types/api";
import { useProjectCanvas } from "./useProjectCanvas";

vi.mock("../api/client", () => ({
  getProjectCanvas: vi.fn(),
  planRequirementExecution: vi.fn(),
  recoverTaskGroup: vi.fn(),
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
  const result = renderHook(() => useProjectCanvas(project.id, setError));
  return { ...result, setError };
}

describe("useProjectCanvas task recovery actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getProjectCanvas).mockResolvedValue(initialCanvas);
  });

  it("恢复任务组并用返回值更新画布", async () => {
    const updatedCanvas = createCanvas(createRequirement("running"));
    vi.mocked(recoverTaskGroup).mockResolvedValue(updatedCanvas);
    const { result } = renderProjectCanvas();

    await waitFor(() => {
      expect(result.current.projectCanvas).toBe(initialCanvas);
    });

    act(() => {
      result.current.selectDagRequirement(initialRequirement);
    });

    await act(async () => {
      await result.current.recoverTaskGroup("requirement-1", "task-1");
    });

    expect(recoverTaskGroup).toHaveBeenCalledTimes(1);
    expect(recoverTaskGroup).toHaveBeenCalledWith("requirement-1", "task-1");
    expect(result.current.selectedDagRequirementId).toBe("requirement-1");
    expect(result.current.projectCanvas).toBe(updatedCanvas);
    expect(result.current.recoveringTaskGroupIds.size).toBe(0);
    expect(result.current.requirementActionError).toBeNull();
  });

  it("API 失败时保持画布和选中需求，并只设置操作错误", async () => {
    vi.mocked(recoverTaskGroup).mockRejectedValue(new Error("节点恢复失败"));
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
      await result.current.recoverTaskGroup("requirement-1", "task-1");
    });

    expect(recoverTaskGroup).toHaveBeenCalledTimes(1);
    expect(recoverTaskGroup).toHaveBeenCalledWith("requirement-1", "task-1");
    expect(result.current.projectCanvas).toBe(initialCanvas);
    expect(result.current.selectedDagRequirementId).toBe("requirement-1");
    expect(result.current.requirementActionError).toBe("节点恢复失败");
    expect(result.current.recoveringTaskGroupIds.size).toBe(0);
    expect(setError).not.toHaveBeenCalled();
  });

  it("多个任务组恢复时分别维护 busy，互不禁用", async () => {
    const resolvers = new Map<string, (data: ProjectCanvasData) => void>();
    vi.mocked(recoverTaskGroup).mockImplementation(
      (_requirementId, taskId) =>
        new Promise((resolve) => resolvers.set(taskId, resolve)),
    );
    const { result } = renderProjectCanvas();

    await waitFor(() => {
      expect(result.current.projectCanvas).toBe(initialCanvas);
    });

    let firstRecovery!: Promise<void>;
    let secondRecovery!: Promise<void>;
    act(() => {
      firstRecovery = result.current.recoverTaskGroup(
        "requirement-1",
        "task-1",
      );
      secondRecovery = result.current.recoverTaskGroup(
        "requirement-1",
        "task-2",
      );
    });
    expect(result.current.recoveringTaskGroupIds).toEqual(
      new Set(["requirement-1:task-1", "requirement-1:task-2"]),
    );

    await act(async () => {
      resolvers.get("task-1")!(initialCanvas);
      await firstRecovery;
    });
    expect(result.current.recoveringTaskGroupIds).toEqual(
      new Set(["requirement-1:task-2"]),
    );

    await act(async () => {
      resolvers.get("task-2")!(initialCanvas);
      await secondRecovery;
    });
    expect(result.current.recoveringTaskGroupIds.size).toBe(0);
  });

  it.each(["completed", "failed"] as const)(
    "queued 时持续轮询状态，并在 %s 终态停止",
    async (terminalStatus) => {
      vi.useFakeTimers();
      try {
        const queuedCanvas = createCanvas(createRequirement("queued"));
        const planningCanvas = createCanvas(createRequirement("planning"));
        const planReadyCanvas = createCanvas(createRequirement("plan_ready"));
        const terminalCanvas = createCanvas(createRequirement(terminalStatus));
        vi.mocked(getProjectCanvas)
          .mockResolvedValueOnce(queuedCanvas)
          .mockResolvedValueOnce(planningCanvas)
          .mockResolvedValueOnce(planReadyCanvas)
          .mockResolvedValueOnce(terminalCanvas);

        const { result } = renderProjectCanvas();
        await act(async () => {
          await Promise.resolve();
        });
        expect(result.current.projectCanvas).toBe(queuedCanvas);

        await act(async () => {
          vi.advanceTimersByTime(2500);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(getProjectCanvas).toHaveBeenCalledTimes(2);
        expect(result.current.projectCanvas).toBe(planningCanvas);

        await act(async () => {
          vi.advanceTimersByTime(2500);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(getProjectCanvas).toHaveBeenCalledTimes(3);
        expect(result.current.projectCanvas).toBe(planReadyCanvas);

        await act(async () => {
          vi.advanceTimersByTime(2500);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(getProjectCanvas).toHaveBeenCalledTimes(4);
        expect(result.current.projectCanvas).toBe(terminalCanvas);

        await act(async () => {
          vi.advanceTimersByTime(3000);
          await Promise.resolve();
        });
        expect(getProjectCanvas).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("规划失败阻塞 FIFO 队列时不轮询", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getProjectCanvas).mockResolvedValue({
        ...initialCanvas,
        active_requirement: null,
        queued_requirements: [
          createRequirement("failed"),
          { ...createRequirement("queued"), id: "requirement-2" },
        ],
      });

      renderProjectCanvas();
      await act(async () => {
        await Promise.resolve();
        vi.advanceTimersByTime(3000);
      });

      expect(getProjectCanvas).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("复用同一项目正在进行的画布请求", async () => {
    vi.useFakeTimers();
    try {
      const planningCanvas = createCanvas(createRequirement("running"));
      let resolvePoll!: (data: ProjectCanvasData) => void;
      vi.mocked(getProjectCanvas)
        .mockResolvedValueOnce(planningCanvas)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolvePoll = resolve;
          }),
        );

      const { result } = renderProjectCanvas();
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        vi.advanceTimersByTime(2500);
      });
      const duplicate = result.current.loadProjectCanvas(project.id);

      expect(getProjectCanvas).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolvePoll(createCanvas(createRequirement("completed")));
        await duplicate;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revision 未变化时保留画布引用，变化或队列重排时更新", async () => {
    const { result } = renderProjectCanvas();

    await waitFor(() => {
      expect(result.current.projectCanvas).toBe(initialCanvas);
    });

    vi.mocked(getProjectCanvas).mockResolvedValueOnce({
      ...initialCanvas,
      active_requirement: { ...initialRequirement },
    });
    await act(async () => {
      await result.current.loadProjectCanvas(project.id);
    });
    expect(getProjectCanvas).toHaveBeenCalledTimes(2);
    expect(result.current.projectCanvas).toBe(initialCanvas);

    act(() => {
      result.current.setProjectCanvas({
        ...initialCanvas,
        project: { ...project, name: "仅名称变化" },
        active_requirement: {
          ...initialRequirement,
          title: "仅标题变化",
        },
      });
    });
    expect(result.current.projectCanvas).toBe(initialCanvas);

    const updatedCanvas = createCanvas({
      ...initialRequirement,
      updated_at: "2026-06-24T00:01:00Z",
    });
    act(() => {
      result.current.setProjectCanvas(updatedCanvas);
    });
    expect(result.current.projectCanvas).toBe(updatedCanvas);

    const queuedFirst = {
      ...createRequirement("queued"),
      id: "requirement-2",
    };
    const queuedSecond = {
      ...createRequirement("queued"),
      id: "requirement-3",
    };
    const queuedCanvas: ProjectCanvasData = {
      ...updatedCanvas,
      active_requirement: null,
      queued_requirements: [queuedFirst, queuedSecond],
    };
    act(() => {
      result.current.setProjectCanvas(queuedCanvas);
    });

    const reorderedCanvas = {
      ...queuedCanvas,
      queued_requirements: [queuedSecond, queuedFirst],
    };
    act(() => {
      result.current.setProjectCanvas(reorderedCanvas);
    });
    expect(result.current.projectCanvas).toBe(reorderedCanvas);
  });
});
