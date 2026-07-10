import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text, Heading } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { HStack } from "@astryxdesign/core/Layout";
import type { StartNodeData } from "../../types/api";
import AstryxComposer from "./AstryxComposer";
import AstryxMessages from "./AstryxMessages";
import {
  buildLiveActivity,
  conversationEventsToStreamEvents,
  projectMessageEntries,
  requirementItemEntries,
} from "./model";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

export default function AstryxChatSurface({ data }: { data: ChatData }) {
  const [preparingRequirement, setPreparingRequirement] = useState(false);
  const hadActiveRequirement = useRef(Boolean(data.requirement));
  const requirementMode = Boolean(data.requirement) || preparingRequirement;

  useEffect(() => {
    if (data.requirement) {
      hadActiveRequirement.current = true;
      setPreparingRequirement(true);
      return;
    }
    if (
      hadActiveRequirement.current &&
      !data.busy &&
      data.conversation === null
    ) {
      hadActiveRequirement.current = false;
      setPreparingRequirement(false);
    }
  }, [data.busy, data.conversation, data.requirement]);

  const entries = useMemo(
    () =>
      requirementMode
        ? requirementItemEntries(data.conversation?.items ?? [])
        : projectMessageEntries(data.projectChat?.messages ?? []),
    [data.conversation?.items, data.projectChat?.messages, requirementMode],
  );
  const activity = useMemo(
    () =>
      buildLiveActivity(
        requirementMode
          ? data.streamEvents
          : conversationEventsToStreamEvents(data.projectChatEvents),
      ),
    [data.projectChatEvents, data.streamEvents, requirementMode],
  );
  const running = requirementMode
    ? Boolean(data.busy || data.conversation?.running)
    : Boolean(data.projectChatBusy || data.projectChat?.running);
  const title = requirementMode ? "需求分支" : "项目对话";

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
                  variant={running ? "warning" : "success"}
                  label={running ? "运行中" : "就绪"}
                  isPulsing={running}
                />
                <Heading level={2}>{title}</Heading>
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
      <LayoutContent padding={0}>
        {data.projectChatError && !requirementMode ? (
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
          emptyState={
            <EmptyState
              title={requirementMode ? "描述你的需求" : "询问当前项目"}
              isCompact
            />
          }
          composer={
            <AstryxComposer
              data={data}
              requirementMode={requirementMode}
              onRequirementModeChange={setPreparingRequirement}
            />
          }
        >
          {entries.length || running || activity.notices.length ? (
            <AstryxMessages
              projectId={data.project.id}
              entries={entries}
              activity={activity}
              running={running}
              branch={requirementMode}
              onOpenRequirement={(id) => data.onOpenRequirement?.(id)}
              onRetryRequirement={(id) =>
                void data.onRetryRequirementSummarySync?.(id)
              }
            />
          ) : null}
        </ChatLayout>
      </LayoutContent>
    </Layout>
  );
}
