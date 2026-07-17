import { useQuery } from "@tanstack/react-query";
import { PixelButton } from "@pxlkit/ui-kit";
import type { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { getApi } from "../../api";
import type { FileEntry, FilePreview } from "../../api/types";
import { DNode } from "../../components/DNode";
import { useCanvasStore } from "../../store/canvasStore";
import { MAX_FILE_REFS, useComposerStore } from "../../store/composerStore";
import { useDomainStore } from "../../store/domainStore";
import { useFilesStore } from "../../store/filesStore";

/* ── 目录节点（FE-FILE-001：按需展开子目录；受限路径显示明确结果） ── */

function DirRow({ entry, depth }: { entry: FileEntry; depth: number }) {
  const expanded = useFilesStore((state) =>
    Boolean(state.expandedDirs[entry.path]),
  );
  const selectedPath = useFilesStore((state) => state.selectedPath);
  const childrenQuery = useQuery({
    queryKey: ["file-dir", entry.path],
    queryFn: () => getApi().listDirectory(entry.path),
    enabled: entry.kind === "directory" && expanded && !entry.restricted,
  });
  return (
    <>
      <div className="ftree__row" style={{ paddingLeft: depth * 14 }}>
        {entry.kind === "directory" ? (
          <button
            type="button"
            className="ftree__item"
            aria-expanded={expanded}
            aria-label={`${expanded ? "折叠" : "展开"}目录 ${entry.path}`}
            onClick={() => useFilesStore.getState().toggleDir(entry.path)}
          >
            <span aria-hidden>{expanded ? "▾" : "▸"}</span> 📁 {entry.name}
            {entry.restricted ? (
              <em className="ftree__restricted">受限</em>
            ) : null}
          </button>
        ) : (
          <button
            type="button"
            className="ftree__item"
            data-selected={selectedPath === entry.path || undefined}
            aria-label={`预览文件 ${entry.path}`}
            onClick={() => useFilesStore.getState().selectPath(entry.path)}
          >
            📄 {entry.name}
          </button>
        )}
      </div>
      {expanded && entry.restricted ? (
        <div
          className="ftree__row ftree__note"
          style={{ paddingLeft: depth * 14 + 14 }}
        >
          受限路径（BE-FILE-001 拒绝访问）
        </div>
      ) : null}
      {expanded && !entry.restricted
        ? (childrenQuery.data ?? []).map((child) => (
            <DirRow key={child.path} entry={child} depth={depth + 1} />
          ))
        : null}
    </>
  );
}

export const DirectoryNode = memo(function DirectoryNode() {
  const rootQuery = useQuery({
    queryKey: ["file-dir", ""],
    queryFn: () => getApi().listDirectory(""),
  });
  return (
    <DNode
      icon="files"
      label="目录"
      chip="按需展开"
      chipTone="cyan"
      width={340}
      ariaLabel="仓库目录"
    >
      <div className="ftree nodrag nowheel" role="tree" aria-label="仓库文件树">
        {(rootQuery.data ?? []).map((entry) => (
          <DirRow key={entry.path} entry={entry} depth={0} />
        ))}
        {rootQuery.isLoading ? <p className="dnode__meta">加载目录…</p> : null}
      </div>
    </DNode>
  );
});

/* ── 查询节点（FE-FILE-001：搜索不清空目录状态） ── */

export const SearchNode = memo(function SearchNode() {
  const searchText = useFilesStore((state) => state.searchText);
  const submit = () => useFilesStore.getState().submitSearch();
  return (
    <DNode
      icon="diag"
      label="搜索"
      width={340}
      ariaLabel="文件搜索"
      actions={
        <PixelButton
          size="sm"
          tone="cyan"
          disabled={!searchText.trim()}
          onClick={submit}
        >
          搜索
        </PixelButton>
      }
    >
      <div className="dnode__inline-form nodrag nowheel">
        <input
          className="dnode__input"
          aria-label="搜索关键字"
          placeholder="路径或文本内容…"
          value={searchText}
          onChange={(event) =>
            useFilesStore.getState().setSearchText(event.target.value)
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <p className="dnode__meta">搜索产生结果节点，不影响目录展开状态。</p>
      </div>
    </DNode>
  );
});

/* ── 结果节点 ── */

export const ResultsNode = memo(function ResultsNode({ data }: NodeProps) {
  const { query } = data as { query: string };
  const resultsQuery = useQuery({
    queryKey: ["file-search", query],
    queryFn: () => getApi().searchFiles(query),
  });
  const results = resultsQuery.data ?? [];
  return (
    <DNode
      icon="requirement"
      label="搜索结果"
      chip={`${results.length} 条`}
      chipTone="cyan"
      width={340}
      ariaLabel={`搜索「${query}」的结果`}
    >
      <ul className="fresults nodrag nowheel" aria-label="搜索结果列表">
        {results.map((result, index) => (
          <li key={`${result.path}:${result.line}:${index}`}>
            <button
              type="button"
              className="fresults__item"
              onClick={() => useFilesStore.getState().selectPath(result.path)}
            >
              <span className="px-font-mono">{result.path}</span>
              {result.line > 0 ? (
                <span className="fresults__excerpt">
                  L{result.line}：{result.excerpt}
                </span>
              ) : null}
            </button>
          </li>
        ))}
        {resultsQuery.data && results.length === 0 ? (
          <li className="dnode__meta">无匹配结果（受限路径不进入搜索）。</li>
        ) : null}
      </ul>
    </DNode>
  );
});

/* ── 预览节点（FE-FILE-002/003：行号、复制路径、引用到 Composer；明确结果） ── */

const PREVIEW_KIND_LABELS: Record<FilePreview["kind"], string> = {
  text: "文本",
  binary: "二进制",
  too_large: "过大",
  non_utf8: "非 UTF-8",
  restricted: "受限",
};

function useAddRef(path: string) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const add = () => {
    const domain = useDomainStore.getState();
    const branchId =
      useCanvasStore.getState().activeConversationBranchId ??
      domain.conversation.root_branch_id;
    const ok = useComposerStore.getState().addFileRef(branchId, path);
    setFeedback(
      ok ? "已加入 Composer" : `引用已满（最多 ${MAX_FILE_REFS} 个）`,
    );
  };
  return { feedback, add };
}

export const PreviewNode = memo(function PreviewNode({ data }: NodeProps) {
  const { path } = data as { path: string };
  const previewQuery = useQuery({
    queryKey: ["file-preview", path],
    queryFn: () => getApi().getFilePreview(path),
  });
  const preview = previewQuery.data;
  const { feedback, add } = useAddRef(path);
  const [copied, setCopied] = useState(false);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <DNode
      icon="spec"
      label="文件预览"
      chip={preview ? PREVIEW_KIND_LABELS[preview.kind] : "加载中"}
      chipTone={preview && preview.kind !== "text" ? "yellow" : "cyan"}
      width={420}
      ariaLabel={`预览 ${path}`}
      actions={
        <>
          <PixelButton
            size="sm"
            variant="outline"
            onClick={() => void copyPath()}
          >
            {copied ? "已复制" : "复制路径"}
          </PixelButton>
          <PixelButton size="sm" tone="green" variant="outline" onClick={add}>
            引用到 Composer
          </PixelButton>
        </>
      }
    >
      <p className="dnode__meta px-font-mono">{path}</p>
      {preview?.kind === "text" && preview.lines ? (
        <pre className="fpreview nodrag nowheel" aria-label="文件内容">
          {preview.lines.map((line, index) => (
            <code key={index}>
              <span className="fpreview__lineno">{index + 1}</span>
              {line}
              {"\n"}
            </code>
          ))}
        </pre>
      ) : null}
      {preview && preview.kind !== "text" ? (
        <p className="dnode__warning" role="status">
          {preview.note}
        </p>
      ) : null}
      {preview?.kind === "text" && preview.truncated ? (
        <p className="dnode__meta">{preview.note}</p>
      ) : null}
      {feedback ? <p className="dnode__meta">{feedback}</p> : null}
    </DNode>
  );
});
