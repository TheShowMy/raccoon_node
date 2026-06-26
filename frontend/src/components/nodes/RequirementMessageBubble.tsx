import React from "react";
import { User, Bot, AlertCircle, FileText } from "lucide-react";
import {
  traceFromMessage,
  buildBubbleStreamFromTrace,
  requirementMessageRoleText,
  formatDate,
} from "../../utils/format";
import type { RequirementMessage } from "../../types/api";
import TraceBubble from "../ui/TraceBubble";

function MessageAvatar({ role }: { role: RequirementMessage["role"] }) {
  if (role === "user") {
    return (
      <div className="requirement-message__avatar" title="你" aria-label="你">
        <User size={14} />
      </div>
    );
  }
  if (role === "assistant") {
    return (
      <div
        className="requirement-message__avatar"
        title="Coordinator"
        aria-label="Coordinator"
      >
        <Bot size={14} />
      </div>
    );
  }
  if (role === "system") {
    return (
      <div
        className="requirement-message__avatar"
        title="系统"
        aria-label="系统"
      >
        <AlertCircle size={14} />
      </div>
    );
  }
  return null;
}

export default function RequirementMessageBubble({
  message,
}: {
  message: RequirementMessage;
}) {
  const trace = traceFromMessage(message);
  if (trace) {
    return (
      <TraceBubble bubbles={buildBubbleStreamFromTrace(trace)} isLive={false} />
    );
  }

  return (
    <div className={`requirement-message requirement-message--${message.role}`}>
      <MessageAvatar role={message.role} />
      <div className="requirement-message__content">
        <div className="requirement-message__meta">
          <span>{requirementMessageRoleText(message.role)}</span>
          <time dateTime={message.created_at}>
            {formatDate(message.created_at)}
          </time>
        </div>
        <div className="requirement-message__bubble">{message.content}</div>
        {(message.references?.length ?? 0) || (message.images?.length ?? 0) ? (
          <div className="requirement-message__refs">
            {(message.references ?? []).map((reference) => (
              <span key={reference.path}>
                <FileText size={13} />
                {reference.path}
              </span>
            ))}
            {(message.images ?? []).map((image) => (
              <span key={image.path}>{image.name}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
