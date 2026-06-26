import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { LiveBubble } from "../../types/api";
import { traceStatusText } from "../../utils/format";

export default function LiveProcessCard({
  title,
  status,
  bubbles,
  live = false,
}: {
  title: string;
  status: "running" | "done" | "error";
  bubbles: LiveBubble[];
  live?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(status === "running" || live);
  const errored =
    status === "error" || bubbles.some((bubble) => bubble.status === "error");
  const bubbleScrollKey = bubbles
    .map((bubble) => `${bubble.id}:${bubble.status}:${bubble.content.length}`)
    .join("|");

  useEffect(() => {
    if (!open || (status !== "running" && !live)) return;
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      body.scrollTop = body.scrollHeight;
      body.querySelectorAll("pre").forEach((element) => {
        element.scrollTop = element.scrollHeight;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [bubbleScrollKey, live, open, status]);

  return (
    <section className={`rq-process rq-process--${errored ? "error" : status}`}>
      <button
        className="rq-process__head"
        type="button"
        onClick={() => setOpen(!open)}
      >
        <span className="rq-process__icon">
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
        <strong>{title || "Pi Agent 过程"}</strong>
        <span>{errored ? "异常" : traceStatusText(status)}</span>
        <span>{bubbles.length} 步</span>
        {status === "running" ? (
          <Loader2 className="rq-spin" size={14} />
        ) : null}
      </button>
      {open ? (
        <div ref={bodyRef} className="rq-process__body">
          {bubbles.length > 0 ? (
            bubbles.map((bubble) => (
              <LiveProcessStep
                key={bubble.id}
                bubble={bubble}
                defaultOpen={live && bubble.type !== "tool"}
              />
            ))
          ) : (
            <div className="rq-process-step rq-process-step--running">
              <span>等待 Pi Agent 事件...</span>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function LiveProcessStep({
  bubble,
  defaultOpen,
}: {
  bubble: LiveBubble;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasContent = Boolean(bubble.content);
  const collapsible = bubble.type === "tool" && hasContent;

  useEffect(() => {
    if (bubble.status === "running" && bubble.type !== "tool") {
      setOpen(true);
    }
  }, [bubble.status, bubble.type]);

  return (
    <div className={`rq-process-step rq-process-step--${bubble.status}`}>
      {collapsible ? (
        <button
          type="button"
          className="rq-process-step__head"
          onClick={() => setOpen((value) => !value)}
        >
          <span>{bubble.label}</span>
          <em>{open ? "收起" : "查看输出"}</em>
        </button>
      ) : (
        <span>{bubble.label}</span>
      )}
      {hasContent && (!collapsible || open) ? (
        <pre>{bubble.content}</pre>
      ) : null}
    </div>
  );
}
