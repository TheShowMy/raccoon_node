import { useQuery } from "@tanstack/react-query";
import { PixelButton } from "@pxlkit/ui-kit";
import { memo, useState } from "react";
import { getApi } from "../../api";
import type { FileEntry, FilePreview } from "../../api/types";
import { useCanvasStore } from "../../store/canvasStore";
import {
  MAX_FILE_REFS,
  composerScopeKey,
  useComposerStore,
} from "../../store/composerStore";
import { useDomainStore } from "../../store/domainStore";
import { useFilesStore } from "../../store/filesStore";

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
        <button
          type="button"
          className="ftree__item"
          data-selected={selectedPath === entry.path || undefined}
          aria-expanded={entry.kind === "directory" ? expanded : undefined}
          aria-label={
            entry.kind === "directory"
              ? `${expanded ? "折叠" : "展开"}目录 ${entry.path}`
              : `预览文件 ${entry.path}`
          }
          onClick={() =>
            entry.kind === "directory"
              ? useFilesStore.getState().toggleDir(entry.path)
              : useFilesStore.getState().selectPath(entry.path)
          }
        >
          <span aria-hidden>
            {entry.kind === "directory" ? (expanded ? "▾" : "▸") : "·"}
          </span>
          <span>{entry.name}</span>
          {entry.restricted ? (
            <em className="ftree__restricted">受限</em>
          ) : null}
        </button>
      </div>
      {expanded && entry.restricted ? (
        <div
          className="ftree__row ftree__note"
          style={{ paddingLeft: depth * 14 + 14 }}
        >
          受限路径（BE-FILE-001 拒绝访问）
        </div>
      ) : null}
      {expanded && !entry.restricted && childrenQuery.isLoading ? (
        <div
          className="ftree__row ftree__note"
          style={{ paddingLeft: depth * 14 + 14 }}
        >
          加载中…
        </div>
      ) : null}
      {expanded && !entry.restricted && childrenQuery.isError ? (
        <div
          className="ftree__row ftree__note"
          style={{ paddingLeft: depth * 14 + 14 }}
        >
          加载失败
        </div>
      ) : null}
      {expanded &&
      !entry.restricted &&
      !childrenQuery.isLoading &&
      !childrenQuery.isError
        ? (childrenQuery.data ?? []).map((child) => (
            <DirRow key={child.path} entry={child} depth={depth + 1} />
          ))
        : null}
    </>
  );
}

export const DirectoryContent = memo(function DirectoryContent() {
  const rootQuery = useQuery({
    queryKey: ["file-dir", ""],
    queryFn: () => getApi().listDirectory(""),
  });
  return (
    <div className="ftree" role="tree" aria-label="仓库文件树">
      {(rootQuery.data ?? []).map((entry) => (
        <DirRow key={entry.path} entry={entry} depth={0} />
      ))}
      {rootQuery.isLoading ? <p className="dnode__meta">加载目录…</p> : null}
      {rootQuery.isError ? <p className="dnode__meta">目录加载失败</p> : null}
    </div>
  );
});

export const SearchContent = memo(function SearchContent() {
  const searchText = useFilesStore((state) => state.searchText);
  const submittedQuery = useFilesStore((state) => state.submittedQuery);
  const submit = () => useFilesStore.getState().submitSearch();
  const resultsQuery = useQuery({
    queryKey: ["file-search", submittedQuery],
    queryFn: () => getApi().searchFiles(submittedQuery ?? ""),
    enabled: Boolean(submittedQuery),
  });
  const results = resultsQuery.data ?? [];
  return (
    <div className="files-search-layout">
      <div className="files-search-form">
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
        <PixelButton
          size="sm"
          tone="cyan"
          disabled={!searchText.trim()}
          onClick={submit}
        >
          搜索
        </PixelButton>
      </div>
      <ul className="fresults" aria-label="搜索结果列表">
        {resultsQuery.isLoading ? (
          <li className="dnode__meta">搜索中…</li>
        ) : resultsQuery.isError ? (
          <li className="dnode__meta">搜索失败</li>
        ) : null}
        {!resultsQuery.isLoading && !resultsQuery.isError
          ? results.map((result, index) => (
              <li key={`${result.path}:${result.line}:${index}`}>
                <button
                  type="button"
                  className="fresults__item"
                  onClick={() =>
                    useFilesStore.getState().selectPath(result.path)
                  }
                >
                  <span className="px-font-mono">{result.path}</span>
                  {result.line > 0 ? (
                    <span className="fresults__excerpt">
                      L{result.line}：{result.excerpt}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          : null}
        {submittedQuery && resultsQuery.data && results.length === 0 ? (
          <li className="dnode__meta">无匹配结果（受限路径不进入搜索）。</li>
        ) : null}
      </ul>
    </div>
  );
});

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
    const key = composerScopeKey(domain.activeConversationSessionId, branchId);
    const ok = useComposerStore.getState().addFileRef(key, path);
    setFeedback(
      ok ? "已加入 Composer" : `引用已满（最多 ${MAX_FILE_REFS} 个）`,
    );
  };
  return { feedback, add };
}

export const PreviewContent = memo(function PreviewContent({
  path,
}: {
  path: string | null;
}) {
  const previewQuery = useQuery({
    queryKey: ["file-preview", path],
    queryFn: () => getApi().getFilePreview(path ?? ""),
    enabled: Boolean(path),
  });
  const preview = previewQuery.data;
  const { feedback, add } = useAddRef(path ?? "");
  const [copied, setCopied] = useState(false);
  if (!path) {
    return <p className="tool-empty-state">从目录或搜索结果中选择文件。</p>;
  }
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="file-preview-layout">
      <div className="file-preview-toolbar">
        <span className="px-font-mono">{path}</span>
        <span className="file-preview-toolbar__kind">
          {previewQuery.isError
            ? "加载失败"
            : preview
              ? PREVIEW_KIND_LABELS[preview.kind]
              : "加载中"}
        </span>
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
      </div>
      {previewQuery.isError ? (
        <p className="dnode__warning" role="alert">
          文件预览加载失败
        </p>
      ) : null}
      {preview?.kind === "text" && preview.lines ? (
        <pre className="fpreview" aria-label="文件内容">
          {preview.lines.map((line, index) => (
            <code key={`${path}-${index}`}>
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
    </div>
  );
});
