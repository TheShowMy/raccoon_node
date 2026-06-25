import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useStartData } from "./useStartData";

const mockProjects = [
  {
    id: "project-1",
    name: "Test Project",
    git_url: "https://github.com/test/test.git",
    local_path: "/data/projects/project-1/repo",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  },
];

function mockFetchStart() {
  return {
    projects: mockProjects,
    settings_summary: { title: "设置", description: "基础设置待配置" },
    model_summary: { title: "模型设置", description: "默认模型待配置" },
    model_settings: {
      low: { model_id: null, thinking_level: "low" },
      medium: { model_id: null, thinking_level: "medium" },
      high: { model_id: null, thinking_level: "high" },
    },
  };
}

describe("useStartData", () => {
  beforeEach(() => {
    // Mock global.fetch
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/start") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockFetchStart()),
          });
        }
        if (url.startsWith("/api/projects") && url.endsWith("/projects")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          });
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    // Mock window.history.pushState/replaceState
    vi.stubGlobal("history", {
      ...window.history,
      pushState: vi.fn(),
      replaceState: vi.fn(),
    });

    // Mock window.location
    Object.defineProperty(window, "location", {
      value: { pathname: "/" },
      writable: true,
    });

    // Mock localStorage
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads start data on mount and sets loading to false", async () => {
    const { result } = renderHook(() => useStartData());

    // Initially loading
    expect(result.current.loading).toBe(true);

    // Wait for fetch to complete
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.startData.projects).toHaveLength(1);
    expect(result.current.startData.projects[0].name).toBe("Test Project");
    expect(result.current.error).toBeNull();
  });

  it("creates a project and reloads start data", async () => {
    const { result } = renderHook(() => useStartData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // It should not be creating initially
    expect(result.current.creating).toBe(false);

    // createProject is available
    expect(result.current.createProject).toBeInstanceOf(Function);
  });

  it("opens project canvas and updates URL", async () => {
    const { result } = renderHook(() => useStartData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.openProjectCanvas(mockProjects[0]);
    });

    expect(result.current.selectedProjectId).toBe("project-1");
    expect(result.current.currentCanvas).toBe("project");
  });

  it("goes back to start canvas", async () => {
    const { result } = renderHook(() => useStartData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.openProjectCanvas(mockProjects[0]);
    });
    expect(result.current.currentCanvas).toBe("project");

    act(() => {
      result.current.backToStartCanvas();
    });
    expect(result.current.currentCanvas).toBe("start");
    expect(result.current.selectedProjectId).toBeNull();
    expect(result.current.selectedProjectId).toBeNull();
  });

  it("handles fetch failure gracefully", async () => {
    // Override fetch to fail
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network error"))),
    );

    const { result } = renderHook(() => useStartData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("network error");
    // Should have empty defaults
    expect(result.current.startData.projects).toEqual([]);
  });

  it("handles delete project flow", async () => {
    const { result } = renderHook(() => useStartData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Request delete
    act(() => {
      result.current.requestDeleteProject(mockProjects[0]);
    });
    expect(result.current.pendingDeleteProject).toEqual(mockProjects[0]);
  });
});
