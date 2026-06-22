import React, { useEffect, useState } from "react";
import {
  ChevronDown,
  Loader2,
  TriangleAlert,
  CheckCircle2,
  Brain,
  FileText,
  Wrench,
} from "lucide-react";
import type { LiveBubble } from "../../types/api";
import { traceStatusText } from "../../utils/format";

function TraceBubbleItem({
  bubble,
  isLive,
}: {
  bubble: LiveBubble;
  isLive: boolean;
}) {
  if (bubble.type === "status") {
    return (
      <div className="trace-status">
        <span />
        {bubble.label}
      </div>
    );
  }

  return (
    <div className={`trace-item trace-item--${bubble.status}`}>
      <div className="trace-item__header">
        <span>
          {bubble.type === "thinking" ? <Brain size={14} /> : null}
          {bubble.type === "tool" ? <Wrench size={14} /> : null}
          {bubble.type === "output" ? <FileText size={14} /> : null}
          {bubble.label}
        </span>
        {!isLive ? <em>{traceStatusText(bubble.status)}</em> : null}
      </div>
      {bubble.content ? <pre>{bubble.content}</pre> : null}
    </div>
  );
}

export default function TraceBubble({
  bubbles,
  isLive,
}: {
  bubbles: LiveBubble[];
  isLive: boolean;
}) {
  const [expanded, setExpanded] = useState(isLive);
  const running = bubbles.some((bubble) => bubble.status === "running");
  const hasError = bubbles.some((bubble) => bubble.status === "error");
  const summary =
    bubbles.find((bubble) => bubble.type !== "status")?.label ??
    bubbles[0]?.label ??
    "";

  useEffect(() => {
    if (isLive || running) {
      setExpanded(true);
    }
  }, [isLive, running]);

  if (bubbles.length === 0) return null;

  return (
    <div
      className={`trace-bubble ${expanded ? "trace-bubble--open" : ""}`}
      data-state={running ? "running" : hasError ? "error" : "done"}
    >
      <button
        className="trace-bubble__header"
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="trace-bubble__title">
          {running ? (
            <Loader2 size={15} className="spin-icon" />
          ) : hasError ? (
            <TriangleAlert size={15} />
          ) : (
            <CheckCircle2 size={15} />
          )}
          {running
            ? "Coordinator 正在分析..."
            : hasError
              ? "分析出错"
              : "分析过程"}
        </span>
        {summary ? (
          <span className="trace-bubble__summary">{summary}</span>
        ) : null}
        <span className="trace-bubble__meta">{bubbles.length} 步</span>
        <ChevronDown size={14} className={expanded ? "rotate-icon" : ""} />
      </button>
      {expanded ? (
        <div className="trace-bubble__content">
          {bubbles.map((bubble) => (
            <TraceBubbleItem bubble={bubble} isLive={isLive} key={bubble.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
