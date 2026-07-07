import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { ProcessRow } from "../../utils/format";

export default function ProcessStreamRows({
  rows,
  running = false,
}: {
  rows: ProcessRow[];
  running?: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="rq-process" aria-label="过程">
      {rows.map((row) => (
        <ProcessRowItem key={row.id} row={row} running={running} />
      ))}
    </section>
  );
}

function ProcessRowItem({ row }: { row: ProcessRow; running?: boolean }) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(
    row.type === "thinking" && row.status === "running",
  );
  const wasRunningRef = useRef(row.status === "running");
  const isTool = row.type === "tool";
  const content = isTool ? row.output : row.content;
  const hasContent = Boolean(content.trim());

  useEffect(() => {
    if (
      row.type === "thinking" &&
      wasRunningRef.current &&
      row.status !== "running"
    ) {
      setOpen(false);
    }
    wasRunningRef.current = row.status === "running";
  }, [row.status, row.type]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [content, open]);

  return (
    <div
      className={`rq-process-row rq-process-row--${isTool ? "tool" : "thinking"} rq-process-row--${row.status}`}
    >
      <button
        type="button"
        className="rq-process-row__head"
        onClick={() => hasContent && setOpen((value) => !value)}
        disabled={!hasContent}
      >
        <span className="rq-process-row__icon">
          {hasContent ? (
            open ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )
          ) : null}
        </span>
        <strong>{isTool ? row.toolName : "Thinking"}</strong>
        {isTool && row.preview ? <span>{row.preview}</span> : null}
        {isTool && row.status === "running" ? (
          <Loader2 className="rq-spin" size={13} />
        ) : null}
      </button>
      {open && hasContent ? (
        <pre ref={bodyRef} className="rq-process-row__content">
          {content}
        </pre>
      ) : null}
    </div>
  );
}

export function ThinkingIndicator() {
  return (
    <div className="rq-thinking-indicator" aria-label="正在思考">
      <span aria-hidden="true">Thinking</span>
      <span className="rq-thinking-indicator__dots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </div>
  );
}
