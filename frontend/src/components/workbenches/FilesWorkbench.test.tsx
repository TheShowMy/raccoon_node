import { describe, expect, it, vi } from "vitest";
import { buildFileTree } from "./FilesWorkbench";

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
