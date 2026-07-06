import { useState } from "react";
import { ChevronDown, Copy, FileText, Loader2 } from "lucide-react";
import { getProjectFileContent } from "../../api/client";
import RichContent from "./RichContent";

export default function DocumentPreview({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const markdown = /\.(md|markdown|mdx)$/i.test(path);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || content !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      setContent((await getProjectFileContent(projectId, path)).content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取文件失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`document-preview ${open ? "is-open" : ""}`}>
      <button type="button" onClick={() => void toggle()} aria-expanded={open}>
        <FileText size={13} />
        <span>{path}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="document-preview__body">
          {loading ? (
            <span className="document-preview__state">
              <Loader2 size={14} className="spin-icon" />
              加载中…
            </span>
          ) : error ? (
            <span className="document-preview__state is-error">{error}</span>
          ) : content !== null ? (
            <>
              <button
                type="button"
                className="document-preview__copy"
                onClick={() => {
                  if (navigator.clipboard) {
                    void navigator.clipboard.writeText(content).catch(() => {});
                  }
                }}
              >
                <Copy size={13} />
                复制
              </button>
              {markdown ? (
                <RichContent content={content} />
              ) : (
                <pre>{content}</pre>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
