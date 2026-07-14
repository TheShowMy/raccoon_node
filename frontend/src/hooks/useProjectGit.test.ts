// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeProjectGitAction, getProjectGitStatus } from "../api/client";
import { useProjectGit } from "./useProjectGit";

vi.mock("../api/client", () => ({
  executeProjectGitAction: vi.fn(),
  getProjectGitDiff: vi.fn(),
  getProjectGitStatus: vi.fn(),
}));

const status = {
  branch: "main",
  head: "abc",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  branches: ["main"],
  remote_configured: true,
  write_blocked: false,
  blocked_reason: null,
  files: [],
};

describe("useProjectGit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getProjectGitStatus).mockResolvedValue(status);
  });

  it("loads status and toggles expansion in one step", async () => {
    const { result } = renderHook(() => useProjectGit());
    await act(async () => Promise.resolve());
    expect(result.current.phase).toBe("collapsed");

    act(() => result.current.toggleExpanded());
    expect(result.current.phase).toBe("expanded");

    act(() => result.current.toggleExpanded());
    expect(result.current.phase).toBe("collapsed");
  });

  it("applies the status returned by a successful action", async () => {
    const next = { ...status, branch: "feature" };
    vi.mocked(executeProjectGitAction).mockResolvedValue(next);
    const { result } = renderHook(() => useProjectGit());
    await waitFor(() => expect(result.current.status).toEqual(status));

    await act(async () => {
      expect(
        await result.current.action(
          { type: "create_branch", branch: "feature" },
          "已创建",
        ),
      ).toBe(true);
    });
    expect(result.current.status?.branch).toBe("feature");
    expect(result.current.lastResult).toBe("已创建");
  });
});
