import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCurrentProject } from "./useCurrentProject";

afterEach(() => vi.unstubAllGlobals());

describe("useCurrentProject", () => {
  it("读取当前项目并应用服务端主题", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            project: { id: "current", name: "Raccoon" },
            theme: "light",
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
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("保留当前项目读取错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("不可用")));
    const { result } = renderHook(() => useCurrentProject());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("不可用");
  });
});
