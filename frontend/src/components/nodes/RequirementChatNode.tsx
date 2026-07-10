import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertDialog,
  Button,
  Card,
  EmptyState,
  HStack,
  LayoutHeader,
  Text,
  VStack,
} from "@astryxdesign/core";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { MessageSquare, Sparkles, X } from "lucide-react";
import type {
  Requirement,
  RequirementConversationPrompt,
  RequirementDraft,
  StartNodeData,
} from "../../types/api";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import ChatComposer from "../ui/ChatComposer";
import ChatTranscript from "../chat/ChatTranscript";
import RequirementCardPanel from "../chat/RequirementCardPanel";
import {
  buildProjectChatItems,
  buildRequirementChatItems,
} from "../chat/buildChatTranscriptItems";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;
type ActiveCard = "requirement" | "project";
type ConfirmAction = "abandon-requirement" | "reset-project-chat";

const MOBILE_BREAKPOINT = "(max-width: 767px)";

export default function RequirementChatNode({ data }: { data: ChatData }) {
  const [draftingRequirement, setDraftingRequirement] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const contentRef = useRef<HTMLDivElement>(null);

  const conversation =
    data.conversation?.id === data.requirement?.id ? data.conversation : null;
  const prompt = data.promptDismissed ? null : (conversation?.prompt ?? null);

  const persistedRequirementActive = Boolean(
    data.requirement &&
    ["analyzing", "clarifying", "draft_ready", "failed"].includes(
      data.requirement.status,
    ),
  );
  const activeCard: ActiveCard =
    draftingRequirement || persistedRequirementActive
      ? "requirement"
      : "project";

  useEffect(() => setDraftingRequirement(false), [data.project.id]);
  useEffect(() => {
    if (data.requirement && !persistedRequirementActive) {
      setDraftingRequirement(false);
    }
  }, [data.requirement, persistedRequirementActive]);
  useEffect(() => setConfirmAction(null), [data.project.id]);

  async function confirm() {
    const action = confirmAction;
    setConfirmAction(null);
    if (action === "abandon-requirement") {
      if (data.requirement) data.onAbandon();
      setDraftingRequirement(false);
      data.onInputChange("");
    } else if (action === "reset-project-chat") {
      await data.onProjectChatReset();
    }
  }

  function continueWithSummary(summary: RequirementDraft) {
    setDraftingRequirement(true);
    data.onInputChange(formatRequirementSummary(summary));
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('[role="combobox"][contenteditable="true"]')
        ?.focus();
    });
  }

  const requirementRunning =
    conversation?.running ??
    (data.requirement ? data.requirement.status === "analyzing" : false);
  const projectRunning = data.projectChat?.running ?? false;
  const running =
    activeCard === "requirement" ? requirementRunning : projectRunning;

  const requirementError = data.error ?? conversation?.error ?? null;
  const projectError = data.projectChatError ?? data.projectChat?.error ?? null;
  const error = activeCard === "requirement" ? requirementError : projectError;

  const requirementItems = useMemo(
    () =>
      buildRequirementChatItems(conversation, data.streamEvents, data.onCancel),
    [conversation, data.streamEvents, data.onCancel],
  );

  const projectItems = useMemo(
    () =>
      buildProjectChatItems(
        data.projectChat,
        data.projectChatEvents,
        (requirementId) =>
          void data.onRetryRequirementSummarySync?.(requirementId),
        data.onOpenRequirement,
      ),
    [
      data.onOpenRequirement,
      data.onRetryRequirementSummarySync,
      data.projectChat,
      data.projectChatEvents,
    ],
  );

  const requirementCanSend =
    !data.busy &&
    !requirementRunning &&
    data.input.trim().length > 0 &&
    (!data.requirement ||
      ["analyzing", "clarifying", "draft_ready", "failed"].includes(
        data.requirement.status,
      ));

  const projectCanSend =
    !data.projectChatBusy &&
    !projectRunning &&
    data.projectChatInput.trim().length > 0;
  const showCommands =
    activeCard === "project" && data.projectChatInput.trim() === "/";

  const hasRequirementCard = Boolean(prompt && data.requirement);
  const hasProjectSummary = Boolean(data.projectChat?.requirement_summary);
  const cardVisible =
    (activeCard === "requirement" && hasRequirementCard) ||
    (activeCard === "project" && hasProjectSummary);

  const cardPanel =
    activeCard === "requirement" ? (
      <RequirementCardPanel
        prompt={prompt}
        requirement={data.requirement}
        summary={null}
        answers={data.answers}
        busy={data.busy}
        onAnswerChange={data.onAnswerChange}
        onSubmitClarifications={data.onSubmitClarifications}
        onConfirm={data.onConfirm}
        onContinueEditing={data.onContinueEditing}
        onContinueWithSummary={continueWithSummary}
      />
    ) : (
      <RequirementCardPanel
        prompt={null}
        requirement={null}
        summary={data.projectChat?.requirement_summary ?? null}
        answers={{}}
        busy={data.projectChatBusy}
        onAnswerChange={() => {}}
        onSubmitClarifications={() => {}}
        onConfirm={() => {}}
        onContinueEditing={() => {}}
        onContinueWithSummary={continueWithSummary}
      />
    );

  const enterRequirement = (description = "") => {
    setDraftingRequirement(true);
    data.onProjectChatInputChange("");
    data.onInputChange(description);
  };

  const handleProjectInput = (value: string) => {
    if (value === "/需求生成" || value.startsWith("/需求生成 ")) {
      enterRequirement(value.slice("/需求生成".length).trimStart());
      return;
    }
    data.onProjectChatInputChange(value);
  };

  const handleProjectSubmit = async () => {
    const command = data.projectChatInput.trim();
    if (command === "/新建会话") {
      await data.onProjectChatReset();
      data.onProjectChatInputChange("");
      return;
    }
    await data.onProjectChatSend();
  };

  const composer = (
    <ChatComposer
      value={activeCard === "requirement" ? data.input : data.projectChatInput}
      projectId={data.project.id}
      references={
        activeCard === "requirement"
          ? (data.references ?? [])
          : (data.projectChatReferences ?? [])
      }
      images={
        activeCard === "requirement"
          ? (data.images ?? [])
          : (data.projectChatImages ?? [])
      }
      onReferencesChange={
        activeCard === "requirement"
          ? (data.onReferencesChange ?? (() => {}))
          : (data.onProjectChatReferencesChange ?? (() => {}))
      }
      onImagesChange={
        activeCard === "requirement"
          ? (data.onImagesChange ?? (() => {}))
          : (data.onProjectChatImagesChange ?? (() => {}))
      }
      disabled={
        activeCard === "requirement"
          ? data.busy || requirementRunning
          : data.projectChatBusy || projectRunning
      }
      canSend={
        activeCard === "requirement" ? requirementCanSend : projectCanSend
      }
      placeholder={composerPlaceholder(activeCard, running, prompt)}
      onChange={
        activeCard === "requirement" ? data.onInputChange : handleProjectInput
      }
      onSubmit={
        activeCard === "requirement" ? data.onSend : handleProjectSubmit
      }
      onStop={
        activeCard === "requirement"
          ? requirementRunning
            ? data.onCancel
            : undefined
          : projectRunning
            ? () => void data.onProjectChatAbort()
            : undefined
      }
    />
  );

  const transcript =
    activeCard === "requirement" ? (
      <ChatTranscript
        items={requirementItems}
        projectId={data.project.id}
        running={requirementRunning}
        error={requirementError}
      />
    ) : (
      <ChatTranscript
        items={projectItems}
        projectId={data.project.id}
        running={projectRunning}
        error={projectError}
      />
    );

  const emptyState =
    activeCard === "requirement" ? (
      <EmptyState
        icon={<Sparkles size={24} />}
        title="描述一个需求"
        description="Coordinator 会用对话澄清范围，并在准备好后给出确认卡片。"
        isCompact
      />
    ) : (
      <EmptyState
        icon={<MessageSquare size={24} />}
        title="询问当前项目"
        description="消息会持久保存，Pi Agent 过程会在这里实时显示。"
        isCompact
      />
    );

  const header = (
    <LayoutHeader hasDivider padding={0}>
      <HStack
        align="center"
        justify="between"
        padding={2}
        style={{ width: "100%" }}
      >
        <VStack gap={0.5}>
          <Text type="large" weight="semibold">
            {activeCard === "requirement" ? "需求生成" : "项目对话"}
          </Text>
          <Text type="supporting" color="secondary" maxLines={1}>
            {activeCard === "requirement"
              ? "Pi 分支会话 · 确认后返回普通聊天"
              : data.project.local_path}
          </Text>
        </VStack>
        {activeCard === "requirement" &&
        (data.requirement || draftingRequirement) ? (
          <Button
            label="放弃当前需求"
            isIconOnly
            variant="ghost"
            size="sm"
            tooltip="放弃当前需求"
            isDisabled={data.busy}
            icon={<X size={15} />}
            onClick={() => {
              if (data.requirement) {
                setConfirmAction("abandon-requirement");
              } else {
                setDraftingRequirement(false);
                data.onInputChange("");
              }
            }}
          />
        ) : null}
        {activeCard === "project" ? (
          <Button
            label="关闭项目问答会话"
            isIconOnly
            variant="ghost"
            size="sm"
            tooltip="关闭项目问答会话"
            isDisabled={data.projectChatBusy || projectRunning}
            icon={<X size={15} />}
            onClick={() => setConfirmAction("reset-project-chat")}
          />
        ) : null}
      </HStack>
    </LayoutHeader>
  );

  const chatLayout = (
    <ChatLayout
      scrollRef={contentRef}
      composer={composer}
      emptyState={emptyState}
      density="compact"
    >
      {activeCard === "requirement"
        ? requirementItems.length > 0 || requirementRunning || requirementError
          ? transcript
          : null
        : projectItems.length > 0 || projectRunning || projectError
          ? transcript
          : null}
    </ChatLayout>
  );

  return (
    <>
      <Card
        width="100%"
        height="100%"
        padding={4}
        className="nodrag"
        style={{ position: "relative", overflow: "hidden" }}
        aria-label="需求会话与项目问答"
      >
        <Layout header={header} height="fill" padding={0}>
          <LayoutContent ref={contentRef} padding={0}>
            {chatLayout}
          </LayoutContent>
        </Layout>
        {showCommands ? (
          <Card
            width="auto"
            height="auto"
            padding={2}
            className="nowheel nodrag chat-command-menu"
            role="menu"
            aria-label="聊天命令"
          >
            <VStack gap={1}>
              <Button
                label="需求生成"
                variant="ghost"
                onClick={() => enterRequirement()}
              />
              <Button
                label="新建会话"
                variant="ghost"
                isDisabled={Boolean(data.requirement)}
                onClick={() => void data.onProjectChatReset()}
              />
            </VStack>
          </Card>
        ) : null}
        {cardVisible && !isMobile ? (
          <Card
            width="auto"
            height="auto"
            padding={0}
            className="nowheel nodrag"
            role="complementary"
            aria-label="需求卡片"
            style={{
              position: "absolute",
              insetInline: "var(--spacing-4)",
              bottom: "calc(var(--spacing-1) * 22)",
              zIndex: 4,
              height: "min(calc(var(--spacing-1) * 95), 48%)",
              minHeight: "calc(var(--spacing-1) * 44)",
              maxHeight: "calc(100% - calc(var(--spacing-1) * 24))",
              overflow: "hidden",
            }}
          >
            {cardPanel}
          </Card>
        ) : null}
      </Card>

      {isMobile && cardVisible ? (
        <Dialog
          isOpen
          onOpenChange={() => {}}
          purpose="required"
          width="100%"
          maxHeight="80vh"
        >
          <Layout
            header={
              <DialogHeader
                title={
                  activeCard === "requirement"
                    ? prompt?.type === "clarification"
                      ? "澄清"
                      : prompt?.type === "confirmation"
                        ? "需求确认"
                        : "需求会话"
                    : "需求说明"
                }
                onOpenChange={() => {}}
              />
            }
            content={
              <LayoutContent padding={0} isScrollable>
                {cardPanel}
              </LayoutContent>
            }
            height="auto"
            padding={0}
          />
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={confirmAction !== null}
        title={
          confirmAction === "abandon-requirement"
            ? "放弃当前需求？"
            : "关闭项目问答？"
        }
        description={
          confirmAction === "abandon-requirement"
            ? "当前需求及已输入内容将被删除，此操作无法撤销。"
            : "当前问答消息和模型上下文将被清空，此操作无法撤销。"
        }
        confirmLabel={
          confirmAction === "abandon-requirement" ? "确认放弃" : "确认关闭"
        }
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => void confirm()}
      />
    </>
  );
}

function composerPlaceholder(
  activeCard: ActiveCard,
  running: boolean,
  prompt: RequirementConversationPrompt | null,
): string {
  if (activeCard === "project") {
    return running
      ? "Pi Agent 正在处理..."
      : "询问项目代码、结构或实现，或输入 /";
  }
  if (running) {
    return "Coordinator 正在处理，过程会实时显示";
  }
  if (prompt?.type === "clarification") {
    return "可回答上方问题，也可以直接补充说明...";
  }
  if (prompt?.type === "confirmation") {
    return "确认前可继续补充或要求修改...";
  }
  if (prompt) {
    return "继续补充当前需求...";
  }
  return "继续描述你的需求...";
}

function formatRequirementSummary(summary: RequirementDraft) {
  const criteria = summary.acceptance_criteria
    .map((item) => `- ${item}`)
    .join("\n");
  return `# ${summary.title}\n\n${summary.summary}\n\n## 验收标准\n\n${criteria}`;
}

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel();
      }}
      title={title}
      description={description}
      cancelLabel="取消"
      actionLabel={confirmLabel}
      actionVariant="destructive"
      onAction={onConfirm}
    />
  );
}
