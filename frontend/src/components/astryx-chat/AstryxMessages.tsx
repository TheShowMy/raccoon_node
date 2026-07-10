import { useEffect, useState } from "react";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useStreamingText } from "@astryxdesign/core/hooks";
import type { TraceBlock } from "../../types/api";
import type { AstryxChatEntry, AstryxLiveActivity } from "./model";
import { toolTarget } from "./model";

function attachmentUrl(projectId: string, path: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(path)}`;
}

function Thinking({ content, running }: { content: string; running: boolean }) {
  const [open, setOpen] = useState(running);
  useEffect(() => setOpen(running), [running]);
  if (!content) return null;
  return (
    <Collapsible
      trigger={running ? "思考中" : "思考过程"}
      isOpen={open}
      onOpenChange={setOpen}
    >
      <Markdown density="compact">{content}</Markdown>
    </Collapsible>
  );
}

function TraceBlocks({ blocks }: { blocks: TraceBlock[] }) {
  return blocks.map((block) => {
    if (block.type === "thinking") {
      return (
        <Thinking
          key={block.id}
          content={block.content}
          running={block.status === "running"}
        />
      );
    }
    return (
      <ChatToolCalls
        key={block.id}
        calls={[
          {
            key: block.id,
            name: block.toolName,
            target: toolTarget(block.input),
            status: block.isError
              ? "error"
              : block.status === "done"
                ? "complete"
                : block.status === "error"
                  ? "error"
                  : "running",
            errorMessage: block.isError ? block.output : undefined,
          },
        ]}
      />
    );
  });
}

function Attachments({
  projectId,
  entry,
}: {
  projectId: string;
  entry: AstryxChatEntry;
}) {
  if (!entry.references.length && !entry.images.length) return null;
  return (
    <VStack gap={2} width="100%">
      {entry.images.length ? (
        <HStack gap={1} wrap="wrap">
          {entry.images.map((image) => (
            <Thumbnail
              key={image.path}
              src={attachmentUrl(projectId, image.path)}
              alt={image.name}
              label={image.name}
            />
          ))}
        </HStack>
      ) : null}
      {entry.references.length ? (
        <HStack gap={1} wrap="wrap">
          {entry.references.map((reference) => (
            <Token key={reference.path} label={reference.path} />
          ))}
        </HStack>
      ) : null}
    </VStack>
  );
}

function RequirementSummary({
  entry,
  onOpen,
  onRetry,
}: {
  entry: AstryxChatEntry;
  onOpen: (requirementId: string) => void;
  onRetry: (requirementId: string) => void;
}) {
  const context = entry.requirementContext;
  if (!context) return null;
  const failed = context.sync_status === "failed";
  return (
    <Banner
      status={
        failed ? "error" : context.sync_status === "synced" ? "success" : "info"
      }
      title={context.draft.title}
      description={context.draft.summary}
      endContent={
        <HStack gap={1}>
          {failed ? (
            <Button
              label="重试写回"
              size="sm"
              variant="secondary"
              onClick={() => onRetry(context.requirement_id)}
            />
          ) : null}
          <Button
            label="打开需求"
            size="sm"
            variant="ghost"
            onClick={() => onOpen(context.requirement_id)}
          />
        </HStack>
      }
    >
      {failed && context.sync_error ? (
        <Text color="secondary">{context.sync_error}</Text>
      ) : null}
    </Banner>
  );
}

function Entry({
  projectId,
  entry,
  onOpenRequirement,
  onRetryRequirement,
}: {
  projectId: string;
  entry: AstryxChatEntry;
  onOpenRequirement: (id: string) => void;
  onRetryRequirement: (id: string) => void;
}) {
  if (entry.role === "system" && !entry.requirementContext) {
    return <ChatSystemMessage>{entry.text || "状态已更新"}</ChatSystemMessage>;
  }
  if (entry.requirementContext) {
    return (
      <RequirementSummary
        entry={entry}
        onOpen={onOpenRequirement}
        onRetry={onRetryRequirement}
      />
    );
  }
  return (
    <ChatMessage
      sender={entry.role}
      avatar={
        entry.role === "assistant" ? (
          <Avatar name="Pi" size="small" />
        ) : undefined
      }
    >
      <Attachments projectId={projectId} entry={entry} />
      <TraceBlocks blocks={entry.traceBlocks} />
      {entry.text ? (
        <ChatMessageBubble
          variant={entry.role === "assistant" ? "ghost" : "filled"}
          metadata={
            <ChatMessageMetadata
              timestamp={<Timestamp value={entry.createdAt} format="time" />}
            />
          }
        >
          <Markdown density="compact">{entry.text}</Markdown>
        </ChatMessageBubble>
      ) : null}
    </ChatMessage>
  );
}

function LiveActivity({
  activity,
  running,
}: {
  activity: AstryxLiveActivity;
  running: boolean;
}) {
  const output = useStreamingText(activity.output, running, { speed: "fast" });
  if (
    !running &&
    !activity.thinking &&
    !activity.output &&
    !activity.tools.length &&
    !activity.notices.length
  ) {
    return null;
  }
  return (
    <ChatMessage sender="assistant" avatar={<Avatar name="Pi" size="small" />}>
      <Thinking content={activity.thinking} running={running} />
      {activity.tools.length ? (
        <ChatToolCalls
          calls={activity.tools.map((tool) => ({
            key: tool.id,
            name: tool.name,
            target: tool.target,
            status: tool.status,
            errorMessage: tool.status === "error" ? tool.output : undefined,
          }))}
          defaultIsExpanded={running}
        />
      ) : null}
      {output ? (
        <ChatMessageBubble variant="ghost">
          <Markdown density="compact">{output}</Markdown>
        </ChatMessageBubble>
      ) : null}
      {activity.notices.map((notice, index) => (
        <ChatSystemMessage key={`${notice}-${index}`}>
          {notice}
        </ChatSystemMessage>
      ))}
      {running &&
      !activity.thinking &&
      !activity.output &&
      !activity.tools.length ? (
        <ChatMessageBubble variant="ghost">...</ChatMessageBubble>
      ) : null}
    </ChatMessage>
  );
}

export default function AstryxMessages({
  projectId,
  entries,
  activity,
  running,
  branch,
  onOpenRequirement,
  onRetryRequirement,
}: {
  projectId: string;
  entries: AstryxChatEntry[];
  activity: AstryxLiveActivity;
  running: boolean;
  branch: boolean;
  onOpenRequirement: (id: string) => void;
  onRetryRequirement: (id: string) => void;
}) {
  return (
    <ChatMessageList density="balanced" gap={3} isStreaming={running}>
      {branch ? (
        <ChatSystemMessage variant="divider">需求分支</ChatSystemMessage>
      ) : null}
      {entries.map((entry) => (
        <Entry
          key={entry.id}
          projectId={projectId}
          entry={entry}
          onOpenRequirement={onOpenRequirement}
          onRetryRequirement={onRetryRequirement}
        />
      ))}
      <LiveActivity activity={activity} running={running} />
    </ChatMessageList>
  );
}
