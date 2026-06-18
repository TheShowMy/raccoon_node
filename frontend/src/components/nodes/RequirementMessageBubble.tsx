import React from "react";
import {
  traceFromMessage,
  buildBubbleStreamFromTrace,
  requirementMessageRoleText,
} from "../../utils/format";
import type { RequirementMessage } from "../../types/api";
import TraceBubble from "../ui/TraceBubble";

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
      <strong>{requirementMessageRoleText(message.role)}</strong>
      <p>{message.content}</p>
    </div>
  );
}
