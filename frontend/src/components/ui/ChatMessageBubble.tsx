import type { ReactNode } from "react";
import { AlertTriangle, Bot, FileText, User } from "lucide-react";
import type { FileReference, ImageAttachment } from "../../types/api";
import { formatDate } from "../../utils/format";
import DocumentPreview from "./DocumentPreview";
import RichContent from "./RichContent";

export type ChatMessageRole = "user" | "assistant" | "system";

export default function ChatMessageBubble({
  role,
  content,
  createdAt,
  assistantLabel = "Pi Agent",
  references = [],
  images = [],
  projectId,
  continued = false,
  children,
}: {
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  assistantLabel?: string;
  references?: FileReference[];
  images?: ImageAttachment[];
  projectId?: string;
  continued?: boolean;
  children?: ReactNode;
}) {
  const label =
    role === "user" ? "你" : role === "assistant" ? assistantLabel : "系统";

  return (
    <article
      className={`rq-message rq-message--${role} ${continued ? "rq-message--continued" : ""}`}
    >
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
            {references.map((reference) =>
              projectId ? (
                <DocumentPreview
                  key={reference.path}
                  projectId={projectId}
                  path={reference.path}
                />
              ) : (
                <span key={reference.path}>
                  <FileText size={13} />
                  {reference.path}
                </span>
              ),
            )}
            {images.map((image) =>
              projectId ? (
                <a
                  key={image.path}
                  href={`/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(image.path.split("/").pop() ?? "")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={`/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(image.path.split("/").pop() ?? "")}`}
                    alt={image.name}
                  />
                </a>
              ) : (
                <span key={image.path}>{image.name}</span>
              ),
            )}
          </div>
        ) : null}
        <RichContent content={content} />
      </div>
    </article>
  );
}
