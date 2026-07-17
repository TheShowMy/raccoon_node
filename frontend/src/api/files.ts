import type { FileEntry, FilePreview, FileSearchResult } from "./types";

/**
 * 文件工作台纯函数（FE-FILE-001/002，假数据层与后端共用语义）：
 * 目录树展开/过滤、搜索投影、预览分类。
 * 受限路径（.git/.raccoon-node/node_modules 等）保留在树中但标记 restricted，
 * 预览与展开返回明确结果（BE-FILE-001 拒绝访问的投影表达）。
 */

export type FileTreeSeed = {
  path: string;
  kind: "directory" | "file";
  size?: number;
  restricted?: boolean;
  /** 文本内容（仅演示文本文件） */
  content?: string;
  /** 预览分类覆盖：binary / non_utf8 / too_large */
  preview?: "binary" | "non_utf8" | "too_large";
  children?: FileTreeSeed[];
};

export type FileTreeIndex = {
  entries: Map<string, FileEntry>;
  contents: Map<string, string>;
  previewHints: Map<string, "binary" | "non_utf8" | "too_large">;
  childrenOf: Map<string, string[]>;
};

/** 文本预览默认上限 128 KiB（BE-FILE-001）与 400 行展示上限 */
export const TEXT_PREVIEW_MAX_BYTES = 128 * 1024;
export const TEXT_PREVIEW_MAX_LINES = 400;

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";

export function buildFileTreeIndex(seeds: FileTreeSeed[]): FileTreeIndex {
  const entries = new Map<string, FileEntry>();
  const contents = new Map<string, string>();
  const previewHints = new Map<string, "binary" | "non_utf8" | "too_large">();
  const childrenOf = new Map<string, string[]>();
  const visit = (seed: FileTreeSeed, parent: string | null) => {
    const entry: FileEntry = {
      path: seed.path,
      name: baseName(seed.path),
      kind: seed.kind,
      size:
        seed.kind === "file" ? (seed.size ?? seed.content?.length ?? 0) : null,
      restricted: Boolean(seed.restricted),
    };
    entries.set(seed.path, entry);
    if (seed.content !== undefined) contents.set(seed.path, seed.content);
    if (seed.preview) previewHints.set(seed.path, seed.preview);
    const parentKey = parent ?? "";
    const siblings = childrenOf.get(parentKey) ?? [];
    siblings.push(seed.path);
    childrenOf.set(parentKey, siblings);
    for (const child of seed.children ?? []) visit(child, seed.path);
    if (!childrenOf.has(seed.path)) childrenOf.set(seed.path, []);
  };
  for (const seed of seeds) visit(seed, null);
  return { entries, contents, previewHints, childrenOf };
}

/** 目录列表：目录在前、按名称排序（FE-FILE-001 目录节点按需展开） */
export function listDirectory(index: FileTreeIndex, path: string): FileEntry[] {
  const children = index.childrenOf.get(path) ?? [];
  return children
    .map((child) => index.entries.get(child)!)
    .sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name)
        : a.kind === "directory"
          ? -1
          : 1,
    );
}

export function rootDirectories(index: FileTreeIndex): FileEntry[] {
  return listDirectory(index, "");
}

/** 搜索投影：路径子串匹配 + 文本内容行匹配；不修改目录展开状态（FE-FILE-001） */
export function searchTree(
  index: FileTreeIndex,
  query: string,
  maxResults = 50,
): FileSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: FileSearchResult[] = [];
  for (const entry of index.entries.values()) {
    if (results.length >= maxResults) break;
    if (entry.restricted) continue; // 受限路径不进入搜索结果（BE-FILE-001）
    if (entry.path.toLowerCase().includes(needle)) {
      results.push({ path: entry.path, line: 0, excerpt: entry.path });
      continue;
    }
    const content = index.contents.get(entry.path);
    if (!content) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) {
        results.push({
          path: entry.path,
          line: i + 1,
          excerpt: lines[i].trim(),
        });
      }
    }
  }
  return results;
}

/** 预览分类（FE-FILE-002）：受限 / 二进制 / 过大 / 非 UTF-8 / 文本 */
export function classifyPreview(
  index: FileTreeIndex,
  path: string,
): FilePreview {
  const entry = index.entries.get(path);
  if (!entry || entry.restricted) {
    return {
      path,
      kind: "restricted",
      lines: null,
      truncated: false,
      note: "受限路径（.git / .raccoon-node / node_modules 等），文件服务拒绝访问。",
    };
  }
  if (entry.kind === "directory") {
    return {
      path,
      kind: "restricted",
      lines: null,
      truncated: false,
      note: "目录不提供预览，请在目录节点中展开。",
    };
  }
  const hint = index.previewHints.get(path);
  if (hint === "binary") {
    return {
      path,
      kind: "binary",
      lines: null,
      truncated: false,
      note: `二进制文件（${entry.size ?? 0} 字节），不支持文本预览。`,
    };
  }
  if (hint === "non_utf8") {
    return {
      path,
      kind: "non_utf8",
      lines: null,
      truncated: false,
      note: "文件不是有效 UTF-8 编码，已按安全策略拒绝展示。",
    };
  }
  if (hint === "too_large" || (entry.size ?? 0) > TEXT_PREVIEW_MAX_BYTES) {
    return {
      path,
      kind: "too_large",
      lines: null,
      truncated: false,
      note: `文件大小 ${entry.size ?? 0} 字节，超过 ${TEXT_PREVIEW_MAX_BYTES / 1024} KiB 预览上限。`,
    };
  }
  const content = index.contents.get(path) ?? "";
  const allLines = content.split("\n");
  const truncated = allLines.length > TEXT_PREVIEW_MAX_LINES;
  return {
    path,
    kind: "text",
    lines: truncated ? allLines.slice(0, TEXT_PREVIEW_MAX_LINES) : allLines,
    truncated,
    note: truncated ? `仅显示前 ${TEXT_PREVIEW_MAX_LINES} 行。` : null,
  };
}
