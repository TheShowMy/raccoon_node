import React, { useState, useRef, useEffect } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  TriangleAlert,
  CheckCircle2,
} from "lucide-react";
import type { LiveBubble } from "../../types/api";
import { traceStatusText } from "../../utils/format";
import { Brain, Wrench } from "lucide-react";

function TraceBubbleItem({
  bubble,
  isLive,
}: {
  bubble: LiveBubble;
  isLive: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!isLive || !preRef.current) return;
    requestAnimationFrame(() => {
      const element = preRef.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }, [bubble.content, isLive]);

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
          {bubble.label}
        </span>
        {!isLive ? <em>{traceStatusText(bubble.status)}</em> : null}
      </div>
      {bubble.content ? <pre ref={preRef}>{bubble.content}</pre> : null}
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
  const contentRef = useRef<HTMLDivElement>(null);
  const running = bubbles.some((bubble) => bubble.status === "running");
  const hasError = bubbles.some((bubble) => bubble.status === "error");

  useEffect(() => {
    if (!expanded || !contentRef.current) return;
    requestAnimationFrame(() => {
      const element = contentRef.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }, [bubbles, expanded]);

  if (bubbles.length === 0) return null;

  return (
    <div className="trace-bubble">
      <button
        className="trace-bubble__header"
        type="button"
        onClick={() => setExpanded((value) => !value)}
      >
        <span>
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
        <span>{bubbles.length} 个气泡</span>
        <ChevronDown size={14} className={expanded ? "rotate-icon" : ""} />
      </button>
      {expanded ? (
        <div className="trace-bubble__content" ref={contentRef}>
          {bubbles.map((bubble) => (
            <TraceBubbleItem bubble={bubble} isLive={isLive} key={bubble.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
