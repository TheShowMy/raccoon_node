import { Fragment } from "react";
import { Banner, Button } from "@astryxdesign/core";
import { ChatMessageList, ChatSystemMessage } from "@astryxdesign/core/Chat";
import { AlertTriangle, Circle } from "lucide-react";
import type { ChatTranscriptItem } from "./types";
import ChatMessageBubble from "../ui/ChatMessageBubble";
import ProcessStreamRows, { ThinkingIndicator } from "../ui/ProcessStreamRows";

type Props = {
  items: ChatTranscriptItem[];
  projectId?: string;
  running?: boolean;
  error?: string | null;
};

function isContinuedMessage(
  previous: ChatTranscriptItem | undefined,
  current: ChatTranscriptItem,
): boolean {
  if (current.kind !== "message") return false;
  if (!previous || previous.kind !== "message") return false;
  if (previous.role !== current.role) return false;
  const previousTime = Date.parse(previous.created_at);
  const currentTime = Date.parse(current.created_at);
  if (Number.isNaN(previousTime) || Number.isNaN(currentTime)) return false;
  return Math.abs(currentTime - previousTime) <= 5 * 60 * 1000;
}

function hasRunningProcess(items: ChatTranscriptItem[]): boolean {
  return items.some((item) => item.kind === "process" && item.rows.length > 0);
}

export default function ChatTranscript({
  items,
  projectId,
  running = false,
  error = null,
}: Props) {
  return (
    <ChatMessageList density="compact" gap={2} isStreaming={running}>
      {items.map((item, index) => {
        const previous = items[index - 1];

        if (item.kind === "notice") {
          const icon =
            item.level === "warning" ? (
              <AlertTriangle size={14} />
            ) : (
              <Circle size={10} />
            );
          if (item.action) {
            return (
              <Banner
                key={item.id}
                status={item.level}
                title={item.text}
                endContent={
                  <Button
                    label={item.action.label}
                    variant={item.action.variant ?? "secondary"}
                    size="sm"
                    onClick={item.action.onClick}
                  />
                }
              />
            );
          }
          return (
            <ChatSystemMessage key={item.id} icon={icon}>
              {item.text}
            </ChatSystemMessage>
          );
        }

        if (item.kind === "process") {
          return (
            <ProcessStreamRows
              key={item.id}
              rows={item.rows}
              running={running}
            />
          );
        }

        const processRows =
          item.processRows && item.processRows.length > 0 ? (
            <ProcessStreamRows
              key={`${item.id}-process`}
              rows={item.processRows}
              running={running}
            />
          ) : null;

        return (
          <Fragment key={item.id}>
            {processRows}
            <ChatMessageBubble
              role={item.role}
              content={item.content}
              references={item.references}
              images={item.images}
              projectId={projectId}
              createdAt={item.created_at}
              assistantLabel={item.assistantLabel}
              continued={isContinuedMessage(previous, item)}
            />
          </Fragment>
        );
      })}
      {running && !hasRunningProcess(items) ? <ThinkingIndicator /> : null}
      {error ? <Banner status="error" title={error} /> : null}
    </ChatMessageList>
  );
}

export { isContinuedMessage };
