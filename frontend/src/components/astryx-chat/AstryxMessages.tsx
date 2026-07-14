import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatToolCalls,
  type ChatToolCallItem,
} from "@astryxdesign/core/Chat";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { Markdown } from "@astryxdesign/core/Markdown";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useStreamingText } from "@astryxdesign/core/hooks";
import { Bot } from "lucide-react";
import type { TraceBlock } from "../../types/api";
import type { AstryxChatEntry, AstryxLiveActivity } from "./model";
import { toolTarget } from "./model";

export type AstryxTimelineItem =
  | {
      kind: "project";
      id: string;
      createdAt: string;
      entry: AstryxChatEntry;
    }
  | {
      kind: "requirement";
      id: string;
      createdAt: string;
      entries: AstryxChatEntry[];
      running: boolean;
      error: string | null;
    };

const HISTORY_BATCH_SIZE = 80;
const EMPTY_ACTIVITY: AstryxLiveActivity = {
  thinking: "",
  output: "",
  tools: [],
  notices: [],
};

function attachmentUrl(path: string) {
  return `/api/attachments/${encodeURIComponent(path)}`;
}

function AssistantIcon() {
  return <Icon icon={Bot} size="md" color="accent" aria-label="Pi Agent" />;
}

function Thinking({ content, running }: { content: string; running: boolean }) {
  const [open, setOpen] = useState(running);
  useEffect(() => setOpen(running), [running]);
  if (!content) return null;
  return (
    <ChatMessageBubble variant="ghost" data-testid="astryx-thinking-bubble">
      <Collapsible
        trigger={
          <HStack gap={2} align="center">
            <StatusDot
              variant={running ? "warning" : "neutral"}
              label={running ? "正在思考" : "思考完成"}
              isPulsing={running}
            />
            <Text weight="bold">{running ? "思考中" : "思考过程"}</Text>
          </HStack>
        }
        isOpen={open}
        onOpenChange={setOpen}
      >
        <Markdown density="compact">{content}</Markdown>
      </Collapsible>
    </ChatMessageBubble>
  );
}

function GroupedToolCalls({ calls }: { calls: ChatToolCallItem[] }) {
  const [expanded, setExpanded] = useState(calls.length <= 3);
  const previousCount = useRef(calls.length);

  useEffect(() => {
    if (previousCount.current <= 3 && calls.length > 3) {
      setExpanded(false);
    }
    previousCount.current = calls.length;
  }, [calls.length]);

  return (
    <ChatToolCalls
      data-testid="astryx-tool-calls"
      calls={calls}
      isExpanded={expanded}
      onExpandedChange={setExpanded}
    />
  );
}

function TraceBlocks({ blocks }: { blocks: TraceBlock[] }) {
  const thinkingBlocks = blocks.filter(
    (block): block is Extract<TraceBlock, { type: "thinking" }> =>
      block.type === "thinking",
  );
  const thinking = thinkingBlocks
    .map((block) => block.content)
    .filter(Boolean)
    .join("\n\n");
  const tools = new Map<string, ChatToolCallItem>();
  for (const block of blocks) {
    if (block.type !== "tool") continue;
    const key = block.toolCallId || block.id;
    tools.set(key, {
      key,
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
    });
  }

  return (
    <>
      <Thinking
        content={thinking}
        running={thinkingBlocks.some((block) => block.status === "running")}
      />
      {tools.size ? <GroupedToolCalls calls={[...tools.values()]} /> : null}
    </>
  );
}

function Attachments({ entry }: { entry: AstryxChatEntry }) {
  if (!entry.references.length && !entry.images.length) return null;
  return (
    <VStack gap={2} width="100%">
      {entry.images.length ? (
        <HStack gap={1} wrap="wrap">
          {entry.images.map((image) => (
            <Thumbnail
              key={image.path}
              src={attachmentUrl(image.path)}
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

function Entry({ entry }: { entry: AstryxChatEntry }) {
  if (entry.role === "system") {
    return <ChatSystemMessage>{entry.text || "状态已更新"}</ChatSystemMessage>;
  }
  return (
    <ChatMessage
      sender={entry.role}
      avatar={entry.role === "assistant" ? <AssistantIcon /> : undefined}
    >
      <Attachments entry={entry} />
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
  onContentChange,
}: {
  activity: AstryxLiveActivity;
  running: boolean;
  onContentChange: () => void;
}) {
  const thinking = useStreamingText(activity.thinking, running, {
    speed: "fast",
  });
  const output = useStreamingText(activity.output, running, { speed: "fast" });
  useLayoutEffect(() => {
    onContentChange();
  }, [activity.notices, activity.tools, onContentChange, output, thinking]);
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
    <ChatMessage sender="assistant" avatar={<AssistantIcon />}>
      <Thinking content={thinking} running={running} />
      {activity.tools.length ? (
        <GroupedToolCalls
          calls={activity.tools.map((tool) => ({
            key: tool.id,
            name: tool.name,
            target: tool.target,
            status: tool.status,
            errorMessage: tool.status === "error" ? tool.output : undefined,
          }))}
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

const MemoEntry = memo(Entry);
const MemoLiveActivity = memo(LiveActivity);

function AstryxMessages({
  timeline,
  projectActivity,
  projectRunning,
  interactiveRequirementId,
  requirementActivity,
  requirementRunning,
  isStreaming,
  onContentChange,
  prepareForPrepend,
  isPinned,
  hasOlderHistory,
  onLoadOlderHistory,
}: {
  timeline: AstryxTimelineItem[];
  projectActivity: AstryxLiveActivity;
  projectRunning: boolean;
  interactiveRequirementId: string | null;
  requirementActivity: AstryxLiveActivity;
  requirementRunning: boolean;
  isStreaming: boolean;
  onContentChange: () => void;
  prepareForPrepend: () => void;
  isPinned: () => boolean;
  hasOlderHistory: boolean;
  onLoadOlderHistory: () => Promise<boolean>;
}) {
  const [visibleCount, setVisibleCount] = useState(HISTORY_BATCH_SIZE);
  const loadingOlderRef = useRef(false);
  const totalPersistentRows = useMemo(
    () =>
      timeline.reduce(
        (total, item) =>
          total +
          (item.kind === "project"
            ? 1
            : item.entries.length + (item.error ? 1 : 0)),
        0,
      ),
    [timeline],
  );
  const previousTotalRef = useRef(totalPersistentRows);

  useEffect(() => {
    const previous = previousTotalRef.current;
    const delta = totalPersistentRows - previous;
    previousTotalRef.current = totalPersistentRows;
    if (delta < 0) {
      setVisibleCount((current) =>
        Math.max(HISTORY_BATCH_SIZE, Math.min(current, totalPersistentRows)),
      );
      return;
    }
    if (delta === 0) return;
    if (loadingOlderRef.current) {
      loadingOlderRef.current = false;
      setVisibleCount((current) =>
        Math.min(totalPersistentRows, current + HISTORY_BATCH_SIZE),
      );
      return;
    }
    if (!isPinned()) {
      setVisibleCount((current) =>
        Math.min(totalPersistentRows, current + delta),
      );
    }
  }, [isPinned, totalPersistentRows]);

  const selection = useMemo(() => {
    let remaining = visibleCount;
    const projectIds = new Set<string>();
    const requirementEntryIds = new Set<string>();
    const requirementIds = new Set<string>();
    const requirementErrorIds = new Set<string>();

    for (
      let index = timeline.length - 1;
      index >= 0 && remaining > 0;
      index -= 1
    ) {
      const item = timeline[index];
      if (item.kind === "project") {
        projectIds.add(item.id);
        remaining -= 1;
        continue;
      }
      if (item.error && remaining > 0) {
        requirementIds.add(item.id);
        requirementErrorIds.add(item.id);
        remaining -= 1;
      }
      for (
        let entryIndex = item.entries.length - 1;
        entryIndex >= 0 && remaining > 0;
        entryIndex -= 1
      ) {
        requirementIds.add(item.id);
        requirementEntryIds.add(`${item.id}:${item.entries[entryIndex].id}`);
        remaining -= 1;
      }
    }
    return {
      projectIds,
      requirementEntryIds,
      requirementIds,
      requirementErrorIds,
    };
  }, [timeline, visibleCount]);

  const hiddenRows = Math.max(0, totalPersistentRows - visibleCount);
  const loadOlder = useCallback(async () => {
    prepareForPrepend();
    if (hiddenRows > 0) {
      setVisibleCount((current) =>
        Math.min(totalPersistentRows, current + HISTORY_BATCH_SIZE),
      );
      return;
    }
    loadingOlderRef.current = true;
    if (!(await onLoadOlderHistory())) {
      loadingOlderRef.current = false;
    }
  }, [hiddenRows, onLoadOlderHistory, prepareForPrepend, totalPersistentRows]);

  useLayoutEffect(() => {
    onContentChange();
  }, [
    onContentChange,
    projectActivity,
    projectRunning,
    timeline,
    visibleCount,
  ]);

  return (
    <ChatMessageList
      density="balanced"
      gap={3}
      isStreaming={isStreaming}
      scrollToTopAction={
        hiddenRows > 0 || hasOlderHistory ? loadOlder : undefined
      }
      data-testid="astryx-unified-message-list"
    >
      {timeline.map((item) =>
        item.kind === "project" ? (
          selection.projectIds.has(item.id) ? (
            <MemoEntry key={item.id} entry={item.entry} />
          ) : null
        ) : selection.requirementIds.has(item.id) ||
          item.id === `requirement-${interactiveRequirementId}` ? (
          <Fragment key={item.id}>
            <ChatSystemMessage variant="divider">需求分支</ChatSystemMessage>
            {item.entries.map((entry) =>
              selection.requirementEntryIds.has(`${item.id}:${entry.id}`) ? (
                <MemoEntry key={entry.id} entry={entry} />
              ) : null,
            )}
            {item.error && selection.requirementErrorIds.has(item.id) ? (
              <ChatSystemMessage>
                需求记录加载失败：{item.error}
              </ChatSystemMessage>
            ) : null}
            <MemoLiveActivity
              activity={
                item.id === `requirement-${interactiveRequirementId}`
                  ? requirementActivity
                  : EMPTY_ACTIVITY
              }
              running={
                item.id === `requirement-${interactiveRequirementId}`
                  ? requirementRunning
                  : item.running
              }
              onContentChange={onContentChange}
            />
          </Fragment>
        ) : null,
      )}
      <MemoLiveActivity
        activity={projectActivity}
        running={projectRunning}
        onContentChange={onContentChange}
      />
    </ChatMessageList>
  );
}

export default memo(AstryxMessages);
