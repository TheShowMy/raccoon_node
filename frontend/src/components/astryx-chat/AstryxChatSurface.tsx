import { memo, useMemo } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text, Heading } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import type { StartNodeData } from "../../types/api";
import AstryxComposer from "./AstryxComposer";
import AstryxMessages, { type AstryxTimelineItem } from "./AstryxMessages";
import { usePinnedChatScroll } from "./usePinnedChatScroll";
import {
  buildLiveActivity,
  conversationEventsToStreamEvents,
  hasLiveContent,
  projectMessageEntries,
  requirementItemEntries,
} from "./model";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

function AstryxChatSurface({ data }: { data: ChatData }) {
  const interactiveRequirementId =
    data.requirement?.id ?? data.requirementOpeningId;
  const requirementMode = interactiveRequirementId !== null;
  const chatScroll = usePinnedChatScroll();

  const projectActivity = useMemo(
    () =>
      buildLiveActivity(
        conversationEventsToStreamEvents(data.projectChatEvents),
      ),
    [data.projectChatEvents],
  );
  const projectRunning =
    Boolean(data.projectChatBusy || data.projectChat?.running) ||
    hasLiveContent(projectActivity);
  const requirementActivity = useMemo(
    () => buildLiveActivity(data.streamEvents),
    [data.streamEvents],
  );
  const requirementRunning = Boolean(
    data.busy ||
    data.conversation?.running ||
    data.requirement?.status === "analyzing" ||
    data.requirementOpeningId ||
    hasLiveContent(requirementActivity),
  );
  const timeline = useMemo<AstryxTimelineItem[]>(() => {
    const projectItems: AstryxTimelineItem[] = projectMessageEntries(
      data.projectChat?.messages ?? [],
    ).map((entry) => ({
      kind: "project",
      id: entry.id,
      createdAt: entry.createdAt,
      entry,
    }));
    const requirementItems: AstryxTimelineItem[] = data.requirementTimeline.map(
      (branch) => {
        return {
          kind: "requirement",
          id: `requirement-${branch.requirementId}`,
          createdAt: branch.createdAt,
          entries: requirementItemEntries(branch.conversation?.items ?? []),
          running:
            branch.opening ||
            branch.loading ||
            Boolean(branch.conversation?.running) ||
            branch.requirement?.status === "analyzing",
          error: branch.error ?? branch.conversation?.error ?? null,
        };
      },
    );
    return [...projectItems, ...requirementItems].sort((left, right) => {
      const leftTime = Date.parse(left.createdAt);
      const rightTime = Date.parse(right.createdAt);
      return (
        (Number.isNaN(leftTime) ? 0 : leftTime) -
        (Number.isNaN(rightTime) ? 0 : rightTime)
      );
    });
  }, [data.projectChat?.messages, data.requirementTimeline]);
  const effectiveStreaming =
    projectRunning ||
    requirementRunning ||
    timeline.some((item) => item.kind === "requirement" && item.running);

  return (
    <Layout
      height="fill"
      padding={0}
      header={
        <LayoutHeader hasDivider padding={2}>
          <Toolbar
            label="聊天状态"
            size="sm"
            startContent={
              <HStack gap={2} align="center">
                <StatusDot
                  variant={effectiveStreaming ? "warning" : "success"}
                  label={effectiveStreaming ? "运行中" : "就绪"}
                  isPulsing={effectiveStreaming}
                />
                <Heading level={2}>项目对话</Heading>
              </HStack>
            }
            endContent={
              <Text type="supporting" color="secondary" maxLines={1}>
                {data.project.name}
              </Text>
            }
          />
        </LayoutHeader>
      }
    >
      <LayoutContent
        padding={0}
        isScrollable={false}
        data-testid="astryx-chat-content"
      >
        <VStack
          width="100%"
          height="100%"
          minHeight={0}
          data-testid="astryx-chat-stack"
        >
          {data.projectChatError ? (
            <Banner
              status="error"
              title="项目聊天不可用"
              description={data.projectChatError}
              container="section"
              endContent={
                data.projectChat?.running ? (
                  <Button
                    label="停止"
                    variant="secondary"
                    onClick={() => void data.onProjectChatAbort()}
                  />
                ) : undefined
              }
            />
          ) : null}
          <ChatLayout
            ref={chatScroll.scrollRef}
            data-testid="astryx-chat-layout"
            emptyState={<EmptyState title="询问当前项目" isCompact />}
            composer={
              <AstryxComposer
                data={data}
                requirementMode={requirementMode}
                onContentChange={chatScroll.onContentChange}
              />
            }
          >
            {timeline.length ||
            effectiveStreaming ||
            projectActivity.notices.length ? (
              <AstryxMessages
                timeline={timeline}
                projectActivity={projectActivity}
                projectRunning={projectRunning}
                interactiveRequirementId={interactiveRequirementId}
                requirementActivity={requirementActivity}
                requirementRunning={requirementRunning}
                isStreaming={effectiveStreaming}
                onContentChange={chatScroll.onContentChange}
                prepareForPrepend={chatScroll.prepareForPrepend}
                isPinned={chatScroll.isPinned}
                hasOlderHistory={data.hasOlderRequirementHistory}
                onLoadOlderHistory={data.onLoadOlderRequirementHistory}
              />
            ) : null}
          </ChatLayout>
        </VStack>
      </LayoutContent>
    </Layout>
  );
}

export default memo(AstryxChatSurface);
