import type { ReactNode } from "react";
import { AlertTriangle, Bot, FileText, User } from "lucide-react";
import type { FileReference, ImageAttachment } from "../../types/api";
import { formatDate } from "../../utils/format";

export type ChatMessageRole = "user" | "assistant" | "system";

export default function ChatMessageBubble({
  role,
  content,
  createdAt,
  assistantLabel = "Pi Agent",
  references = [],
  images = [],
  projectId,
  children,
}: {
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  assistantLabel?: string;
  references?: FileReference[];
  images?: ImageAttachment[];
  projectId?: string;
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
        {references.length || images.length ? (
          <div className="rq-message__refs">
            {references.map((reference) => (
              <span key={reference.path}>
                <FileText size={13} />
                {reference.path}
              </span>
            ))}
            {images.map((image) =>
              projectId ? (
                <img
                  key={image.path}
                  src={`/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(image.path.split("/").pop() ?? "")}`}
                  alt={image.name}
                />
              ) : (
                <span key={image.path}>{image.name}</span>
              ),
            )}
          </div>
        ) : null}
        {content.trim() ? <p>{content}</p> : null}
      </div>
    </article>
  );
}
