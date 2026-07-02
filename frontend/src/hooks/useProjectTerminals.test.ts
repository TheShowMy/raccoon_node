// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectTerminals, getTerminalCommandProfiles } from "../api/client";
import { useProjectTerminals } from "./useProjectTerminals";

vi.mock("../api/client", () => ({
  createProjectTerminal: vi.fn(),
  deleteProjectTerminal: vi.fn(),
  getProjectTerminals: vi.fn(),
  getTerminalCommandProfiles: vi.fn(),
  putTerminalCommandProfiles: vi.fn(),
}));

describe("useProjectTerminals", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getProjectTerminals).mockResolvedValue([]);
    vi.mocked(getTerminalCommandProfiles).mockResolvedValue([]);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "false"),
      setItem: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("always starts collapsed and does not persist toggles", async () => {
    const { result } = renderHook(() =>
      useProjectTerminals("project-1", false),
    );

    await waitFor(() => expect(getProjectTerminals).toHaveBeenCalled());
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(false);
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it("resets to collapsed when the project changes", async () => {
    const { result, rerender } = renderHook(
      ({ projectId }) => useProjectTerminals(projectId, false),
      { initialProps: { projectId: "project-1" } },
    );

    await waitFor(() => expect(getProjectTerminals).toHaveBeenCalled());
    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(false);

    rerender({ projectId: "project-2" });
    await waitFor(() => expect(result.current.collapsed).toBe(true));
  });
});
