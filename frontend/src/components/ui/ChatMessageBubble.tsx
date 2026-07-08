import type { ReactNode } from "react";
import {
  ChatMessage,
  ChatMessageBubble as AstryxChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
} from "@astryxdesign/core/Chat";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { HStack, VStack } from "@astryxdesign/core";
import { AlertTriangle } from "lucide-react";
import type { FileReference, ImageAttachment } from "../../types/api";
import DocumentPreview from "./DocumentPreview";

export type ChatMessageRole = "user" | "assistant" | "system";

function attachmentBasename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? "";
}

export default function ChatMessageBubble({
  role,
  content,
  createdAt,
  assistantLabel = "Pi Agent",
  references = [],
  images = [],
  projectId,
  children,
  continued,
}: {
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  assistantLabel?: string;
  references?: FileReference[];
  images?: ImageAttachment[];
  projectId?: string;
  children?: ReactNode;
  continued?: boolean;
}) {
  const label =
    role === "user" ? "你" : role === "assistant" ? assistantLabel : "系统";

  const metadata = continued ? undefined : (
    <ChatMessageMetadata
      timestamp={
        <Timestamp
          value={createdAt}
          format="auto"
          size="sm"
          color="secondary"
        />
      }
    />
  );

  const avatar = continued ? undefined : (
    <Avatar name={label} size="small" alt={label} />
  );

  const attachments =
    references.length > 0 || images.length > 0 || children ? (
      <VStack gap={2} align="stretch">
        {children}
        {references.length > 0 ? (
          <HStack wrap="wrap" gap={1.5}>
            {references.map((reference) =>
              projectId ? (
                <DocumentPreview
                  key={reference.path}
                  projectId={projectId}
                  path={reference.path}
                />
              ) : (
                <span key={reference.path}>{reference.path}</span>
              ),
            )}
          </HStack>
        ) : null}
        {images.length > 0 ? (
          <HStack className="rq-message-bubble__images" wrap="wrap" gap={1.5}>
            {images.map((image) => {
              const basename = attachmentBasename(image.path);
              const src = projectId
                ? `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(basename)}`
                : image.path;
              return projectId ? (
                <a key={image.path} href={src} target="_blank" rel="noreferrer">
                  <img src={src} alt={image.name} />
                </a>
              ) : (
                <span key={image.path}>{image.name}</span>
              );
            })}
          </HStack>
        ) : null}
      </VStack>
    ) : null;

  const body = (
    <>
      {attachments}
      <Markdown density="compact" headingLevelStart={3}>
        {content}
      </Markdown>
    </>
  );

  if (role === "system") {
    return (
      <ChatSystemMessage icon={<AlertTriangle size={14} />}>
        {body}
      </ChatSystemMessage>
    );
  }

  return (
    <ChatMessage sender={role} avatar={avatar}>
      <AstryxChatMessageBubble
        variant={role === "user" ? "filled" : "ghost"}
        name={continued ? undefined : label}
        metadata={metadata}
      >
        {body}
      </AstryxChatMessageBubble>
    </ChatMessage>
  );
}
