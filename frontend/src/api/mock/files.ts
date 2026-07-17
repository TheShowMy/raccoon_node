import {
  buildFileTreeIndex,
  classifyPreview,
  listDirectory,
  rootDirectories,
  searchTree,
  type FileTreeIndex,
} from "../files";
import type { FileEntry, FilePreview, FileSearchResult } from "../types";
import { DEMO_FILE_TREE } from "./filesData";

/** 文件模块（假数据层）：目录展开/搜索/预览全部是只读查询（03 §13 文件 API） */
export class FilesModule {
  private readonly index: FileTreeIndex = buildFileTreeIndex(DEMO_FILE_TREE);

  constructor(private readonly deps: { latency: () => Promise<void> }) {}

  async listDirectory(path: string): Promise<FileEntry[]> {
    await this.deps.latency();
    const entry = this.index.entries.get(path);
    if (path !== "" && (!entry || entry.kind !== "directory")) {
      throw new Error(`目录不存在：${path}`);
    }
    if (entry?.restricted) {
      throw new Error(`受限路径拒绝访问：${path}`);
    }
    return path === ""
      ? rootDirectories(this.index)
      : listDirectory(this.index, path);
  }

  async search(query: string): Promise<FileSearchResult[]> {
    await this.deps.latency();
    return searchTree(this.index, query);
  }

  async preview(path: string): Promise<FilePreview> {
    await this.deps.latency();
    return classifyPreview(this.index, path);
  }

  summaryLines(): string[] {
    let files = 0;
    let restricted = 0;
    for (const entry of this.index.entries.values()) {
      if (entry.kind === "file") files += 1;
      if (entry.restricted) restricted += 1;
    }
    return [
      `演示仓库文件 ${files} 个`,
      `受限路径 ${restricted} 处（.git 等）`,
      "搜索 / 预览 / 引用到 Composer",
    ];
  }
}
