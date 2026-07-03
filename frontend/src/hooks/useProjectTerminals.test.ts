// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectTerminal,
  deleteProjectTerminal,
  getProjectTerminals,
  getTerminalCommandProfiles,
} from "../api/client";
import type { TerminalSession } from "../types/api";
import { useProjectTerminals } from "./useProjectTerminals";

vi.mock("../api/client", () => ({
  createProjectTerminal: vi.fn(),
  deleteProjectTerminal: vi.fn(),
  getProjectTerminals: vi.fn(),
  getTerminalCommandProfiles: vi.fn(),
  putTerminalCommandProfiles: vi.fn(),
}));

describe("useProjectTerminals", () => {
  const piSession = (id: string): TerminalSession => ({
    id,
    project_id: "project-1",
    title: "Pi 登录",
    command: "pi --no-session --no-extensions --no-context-files",
    status: "running",
    exit_code: null,
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
  });

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

  it("starts an independent Pi login session without opening the project terminal", async () => {
    vi.mocked(createProjectTerminal).mockResolvedValue(piSession("pi-1"));
    const { result } = renderHook(() =>
      useProjectTerminals("project-1", false),
    );
    await waitFor(() => expect(getProjectTerminals).toHaveBeenCalled());

    await act(async () => result.current.startPiLoginTerminal());

    expect(createProjectTerminal).toHaveBeenCalledWith("project-1", {
      command: "pi --no-session --no-extensions --no-context-files",
      title: "Pi 登录",
    });
    expect(result.current.piLoginSession?.id).toBe("pi-1");
    expect(result.current.sessions).toEqual([]);
    expect(result.current.collapsed).toBe(true);
  });

  it("restarts and closes only the embedded Pi login session", async () => {
    vi.mocked(createProjectTerminal)
      .mockResolvedValueOnce(piSession("pi-1"))
      .mockResolvedValueOnce(piSession("pi-2"));
    vi.mocked(deleteProjectTerminal).mockResolvedValue([]);
    const { result } = renderHook(() =>
      useProjectTerminals("project-1", false),
    );
    await waitFor(() => expect(getProjectTerminals).toHaveBeenCalled());

    await act(async () => result.current.startPiLoginTerminal());
    await act(async () => result.current.startPiLoginTerminal());
    expect(deleteProjectTerminal).toHaveBeenCalledWith("project-1", "pi-1");
    expect(result.current.piLoginSession?.id).toBe("pi-2");

    await act(async () => result.current.closePiLoginTerminal());
    expect(deleteProjectTerminal).toHaveBeenLastCalledWith("project-1", "pi-2");
    expect(result.current.piLoginSession).toBeNull();
    expect(result.current.sessions).toEqual([]);
  });

  it("does not retain a deleted session when restart creation fails", async () => {
    vi.mocked(createProjectTerminal)
      .mockResolvedValueOnce(piSession("pi-1"))
      .mockRejectedValueOnce(new Error("Pi 启动失败"));
    vi.mocked(deleteProjectTerminal).mockResolvedValue([]);
    const { result } = renderHook(() =>
      useProjectTerminals("project-1", false),
    );
    await waitFor(() => expect(getProjectTerminals).toHaveBeenCalled());

    await act(async () => result.current.startPiLoginTerminal());
    await act(async () => result.current.startPiLoginTerminal());

    expect(result.current.piLoginSession).toBeNull();
    expect(result.current.piLoginError).toContain("Pi 启动失败");
  });
});
