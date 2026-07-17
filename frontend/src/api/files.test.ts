import { describe, expect, it } from "vitest";
import {
  buildFileTreeIndex,
  classifyPreview,
  listDirectory,
  rootDirectories,
  searchTree,
} from "./files";
import { DEMO_FILE_TREE } from "./mock/filesData";

const index = buildFileTreeIndex(DEMO_FILE_TREE);

describe("文件树过滤与展开（FE-FILE-001）", () => {
  it("根目录列表目录在前、受限路径保留但标记", () => {
    const root = rootDirectories(index);
    const kinds = root.map((entry) => entry.kind);
    expect(kinds.indexOf("file")).toBeGreaterThan(
      kinds.lastIndexOf("directory"),
    );
    const restricted = root.filter((entry) => entry.restricted);
    expect(restricted.map((entry) => entry.path).sort()).toEqual([
      ".git",
      ".raccoon-node",
      "node_modules",
    ]);
  });

  it("按需展开：子目录内容与排序", () => {
    const docs = listDirectory(index, "docs");
    expect(docs.map((entry) => entry.path)).toEqual([
      "docs/rewrite",
      "docs/big-spec.md",
    ]);
    const rewrite = listDirectory(index, "docs/rewrite");
    expect(rewrite).toHaveLength(2);
    expect(rewrite[0].name.endsWith(".md")).toBe(true);
  });
});

describe("搜索投影（FE-FILE-001）", () => {
  it("路径子串匹配", () => {
    const results = searchTree(index, "tokens");
    expect(results.map((result) => result.path)).toContain(
      "frontend/src/theme/tokens.css",
    );
  });

  it("文本内容行匹配（带行号）", () => {
    const results = searchTree(index, "merge_tasks");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("src/workflow.rs");
    expect(results[0].line).toBe(6);
  });

  it("受限路径不进入搜索结果", () => {
    const results = searchTree(index, "git");
    expect(results.every((result) => !result.path.startsWith(".git"))).toBe(
      true,
    );
  });

  it("空查询返回空结果", () => {
    expect(searchTree(index, "  ")).toEqual([]);
  });
});

describe("预览分类（FE-FILE-002）", () => {
  it("文本文件带行内容", () => {
    const preview = classifyPreview(index, "src/main.rs");
    expect(preview.kind).toBe("text");
    expect(preview.lines?.[0]).toBe("fn main() {");
    expect(preview.truncated).toBe(false);
  });

  it("二进制 / 过大 / 非 UTF-8 / 受限各有明确说明", () => {
    expect(classifyPreview(index, "assets/logo.png").kind).toBe("binary");
    expect(classifyPreview(index, "docs/big-spec.md").kind).toBe("too_large");
    expect(classifyPreview(index, "data/legacy.bin").kind).toBe("non_utf8");
    const restricted = classifyPreview(index, ".git");
    expect(restricted.kind).toBe("restricted");
    expect(restricted.note).toContain("受限路径");
  });

  it("目录不提供预览", () => {
    expect(classifyPreview(index, "src").kind).toBe("restricted");
  });
});
