import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import FilesWorkbench, { buildFileTree } from "./FilesWorkbench";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("buildFileTree", () => {
  it("groups repository paths and keeps the selected file actionable", () => {
    const onOpen = vi.fn();
    const tree = buildFileTree(
      ["src/main.rs", "src/api/mod.rs", "README.md"],
      "src/api/mod.rs",
      onOpen,
    );

    expect(tree.map((item) => item.id)).toEqual([
      "folder:src",
      "file:README.md",
    ]);
    const src = tree[0];
    expect(src.children?.map((item) => item.id)).toEqual([
      "folder:src/api",
      "file:src/main.rs",
    ]);
    const selected = src.children?.[0].children?.[0];
    expect(selected?.id).toBe("file:src/api/mod.rs");
    expect(selected?.isSelected).toBe(true);
    selected?.onClick?.({} as React.MouseEvent);
    expect(onOpen).toHaveBeenCalledWith("src/api/mod.rs");
  });
});

describe("FilesWorkbench", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders with scrollable areas marked for React Flow wheel handling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/files/tree")) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.includes("/files?")) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );

    render(<FilesWorkbench projectId="current" />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("搜索仓库文件")).toBeInTheDocument();
    });

    const scrollables = document.querySelectorAll(".nodrag.nowheel");
    expect(scrollables.length).toBeGreaterThanOrEqual(2);
  });
});
