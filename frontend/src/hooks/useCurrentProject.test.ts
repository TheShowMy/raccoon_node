import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCurrentProject } from "./useCurrentProject";
import { THEME_CACHE_KEY } from "../theme/astryxThemes";

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // localStorage can be unavailable in restricted test environments.
  }
});

describe("useCurrentProject", () => {
  it("读取当前项目并应用服务端主题", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            project: { id: "current", name: "Raccoon" },
            theme_pack: "matcha",
            theme_mode: "light",
            publication_readiness: {
              mode: "local",
              ready: true,
              summary: "本地合并",
              issues: [],
              notes: [],
            },
          }),
      }),
    );

    const { result } = renderHook(() => useCurrentProject());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetch).toHaveBeenCalledWith("/api/project/current");
    expect(result.current.project?.id).toBe("current");
    expect(result.current.publicationReadiness?.mode).toBe("local");
    expect(result.current.themePack).toBe("matcha");
    expect(result.current.themeMode).toBe("light");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe(
      JSON.stringify({ theme_pack: "matcha", theme_mode: "light" }),
    );
  });

  it("优先使用浏览器缓存主题并在后端返回后覆盖", async () => {
    localStorage.setItem(
      THEME_CACHE_KEY,
      JSON.stringify({ theme_pack: "butter", theme_mode: "light" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            project: { id: "current", name: "Raccoon" },
            theme_pack: "matcha",
            theme_mode: "dark",
            publication_readiness: {
              mode: "local",
              ready: true,
              summary: "本地合并",
              issues: [],
              notes: [],
            },
          }),
      }),
    );

    const { result } = renderHook(() => useCurrentProject());

    expect(result.current.themePack).toBe("butter");
    expect(result.current.themeMode).toBe("light");

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.themePack).toBe("matcha");
    expect(result.current.themeMode).toBe("dark");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe(
      JSON.stringify({ theme_pack: "matcha", theme_mode: "dark" }),
    );
  });

  it("保留当前项目读取错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("不可用")));
    const { result } = renderHook(() => useCurrentProject());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("不可用");
  });
});
