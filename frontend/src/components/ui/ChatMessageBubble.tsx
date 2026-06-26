import type { ReactNode } from "react";
import { AlertTriangle, Bot, User } from "lucide-react";
import { formatDate } from "../../utils/format";

export type ChatMessageRole = "user" | "assistant" | "system";

export default function ChatMessageBubble({
  role,
  content,
  createdAt,
  assistantLabel = "Pi Agent",
  children,
}: {
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  assistantLabel?: string;
  children?: ReactNode;
}) {
  const label =
    role === "user" ? "你" : role === "assistant" ? assistantLabel : "系统";

  return (
    <article className={`rq-message rq-message--${role}`}>
      <div className="rq-message__avatar">
        {role === "user" ? <User size={14} /> : null}
        {role === "assistant" ? <Bot size={14} /> : null}
        {role === "system" ? <AlertTriangle size={14} /> : null}
      </div>
      <div className="rq-message__body">
        <div className="rq-message__meta">
          <span>{label}</span>
          <time dateTime={createdAt}>{formatDate(createdAt)}</time>
        </div>
        {children ? (
          <div className="rq-message__attachments">{children}</div>
        ) : null}
        {content.trim() ? <p>{content}</p> : null}
      </div>
    </article>
  );
}
