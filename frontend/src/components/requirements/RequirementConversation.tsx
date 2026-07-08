import React, { useMemo, useState } from "react";
import { Banner, Button, Card, IconButton, TextArea } from "@astryxdesign/core";
import { ChatMessageList } from "@astryxdesign/core/Chat";
import {
  AlertTriangle,
  Check,
  Circle,
  MessageSquare,
  Sparkles,
  X,
} from "lucide-react";
import type {
  DraftClarificationAnswer,
  Requirement,
  RequirementClarification,
  RequirementConversation,
  RequirementConversationItem,
  RequirementConversationPrompt,
  FileReference,
  ImageAttachment,
  StreamEvent,
} from "../../types/api";
import {
  buildProcessRowsFromAgentEvents,
  buildProcessRowsFromTrace,
  createDraftAnswer,
  hasDraftAnswer,
  requirementStatusText,
  toggleClarificationOption,
  traceFromMetadata,
} from "../../utils/format";
import ChatComposer from "../ui/ChatComposer";
import ChatMessageBubble from "../ui/ChatMessageBubble";
import ProcessStreamRows, { ThinkingIndicator } from "../ui/ProcessStreamRows";
import AnchoredScroll from "../ui/AnchoredScroll";

type Props = {
  conversation: RequirementConversation | null;
  requirement: Requirement | null;
  projectName: string;
  projectId: string;
  prompt: RequirementConversationPrompt | null;
  input: string;
  references?: FileReference[];
  images?: ImageAttachment[];
  busy: boolean;
  error: string | null;
  streamEvents: StreamEvent[];
  answers: Record<string, DraftClarificationAnswer>;
  onInputChange: (value: string) => void;
  onReferencesChange?: (references: FileReference[]) => void;
  onImagesChange?: (images: ImageAttachment[]) => void;
  onSend: () => Promise<void>;
  onAnswerChange: (
    clarification: RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  onSubmitClarifications: (requirement: Requirement) => Promise<void>;
  onConfirm: (requirement: Requirement) => Promise<void>;
  onRetryAnalysis?: (requirement: Requirement) => Promise<void>;
  onContinueEditing: (requirement: Requirement) => void;
  onCancel: () => void;
  onAbandon: () => void;
};

export default function RequirementConversationWorkbench({
  conversation,
  requirement,
  projectName,
  projectId,
  prompt,
  input,
  references = [],
  images = [],
  busy,
  error,
  streamEvents,
  answers,
  onInputChange,
  onReferencesChange = () => {},
  onImagesChange = () => {},
  onSend,
  onAnswerChange,
  onSubmitClarifications,
  onConfirm,
  onRetryAnalysis = async () => {},
  onContinueEditing,
  onCancel,
  onAbandon,
}: Props) {
  const running =
    conversation?.running ??
    (requirement ? requirement.status === "analyzing" : false);
  const hasPrompt = Boolean(prompt);
  const canSend =
    !busy &&
    !running &&
    input.trim().length > 0 &&
    (!requirement ||
      ["analyzing", "clarifying", "draft_ready", "failed"].includes(
        requirement.status,
      ));

  async function submit() {
    if (canSend) {
      await onSend();
    }
  }

  return (
    <>
      <div className="node-header node-header--model">
        <span className="node-icon">
          <MessageSquare size={20} />
        </span>
        <div>
          <strong>
            {conversation?.title ?? requirement?.title ?? "新的需求会话"}
          </strong>
          <span>
            {projectName} ·{" "}
            {conversation
              ? requirementStatusText(conversation.status)
              : requirement
                ? requirementStatusText(requirement.status)
                : "等待描述"}
          </span>
        </div>
        {requirement && requirement.status !== "completed" ? (
          <IconButton
            className="node-header__action rq-abandon-btn"
            label="放弃当前需求"
            tooltip="放弃当前需求"
            icon={<X size={15} />}
            size="sm"
            variant="ghost"
            isDisabled={busy}
            onClick={onAbandon}
          />
        ) : null}
      </div>

      <div className="rq-workbench">
        <RequirementTranscript
          conversation={conversation}
          running={running}
          streamEvents={streamEvents}
          error={error ?? conversation?.error ?? null}
          onCancel={onCancel}
        />

        {requirement?.status === "failed" && !requirement.draft && !prompt ? (
          <Button
            label="重新分析"
            variant="secondary"
            className="requirement-draft__confirm"
            isDisabled={busy}
            onClick={() => void onRetryAnalysis(requirement)}
          />
        ) : null}

        {prompt && requirement ? (
          <RequirementPromptLayer>
            {prompt.type === "clarification" ? (
              <RequirementAskCard
                prompt={prompt}
                answers={answers}
                busy={busy}
                onAnswerChange={onAnswerChange}
                onSubmit={() => void onSubmitClarifications(requirement)}
              />
            ) : (
              <RequirementConfirmCard
                prompt={prompt}
                requirement={requirement}
                busy={busy}
                onConfirm={() => void onConfirm(requirement)}
                onContinueEditing={() => onContinueEditing(requirement)}
              />
            )}
          </RequirementPromptLayer>
        ) : null}

        <ChatComposer
          value={input}
          projectId={projectId}
          references={references}
          images={images}
          onReferencesChange={onReferencesChange}
          onImagesChange={onImagesChange}
          disabled={busy || running}
          canSend={canSend}
          placeholder={
            running
              ? "Coordinator 正在处理，过程会实时显示"
              : prompt?.type === "clarification"
                ? "可回答上方问题，也可以直接补充说明..."
                : prompt?.type === "confirmation"
                  ? "确认前可继续补充或要求修改..."
                  : hasPrompt
                    ? "继续补充当前需求..."
                    : "继续描述你的需求..."
          }
          onChange={onInputChange}
          onSubmit={submit}
          onStop={running ? onCancel : undefined}
          sendLabel="发送"
          stopLabel="停止分析"
        />
      </div>
    </>
  );
}

function RequirementTranscript({
  conversation,
  running,
  streamEvents,
  error,
  onCancel,
}: {
  conversation: RequirementConversation | null;
  running: boolean;
  streamEvents: StreamEvent[];
  error: string | null;
  onCancel: () => void;
}) {
  const liveRows = useMemo(
    () => buildProcessRowsFromAgentEvents(streamEvents),
    [streamEvents],
  );
  const notices = streamEvents.filter(
    (event) => event.event === "notice.append",
  );

  return (
    <AnchoredScroll
      className="rq-transcript nowheel nodrag"
      version={`${conversation?.updated_at ?? "empty"}:${streamEvents.length}:${liveRows.length}`}
    >
      {conversation ? (
        <ChatMessageList
          className="rq-transcript__items"
          density="compact"
          gap={2}
          isStreaming={running}
        >
          {conversation.items.map((item, index) => (
            <RequirementTranscriptItem
              key={item.id}
              item={item}
              continued={isContinuedItem(conversation.items[index - 1], item)}
              projectId={conversation.project_id}
            />
          ))}
          {notices.length > 0 ? (
            <Banner
              className="rq-notice rq-notice--info"
              status="info"
              title={notices.at(-1)?.message ?? ""}
            />
          ) : null}
          {streamEvents.some((e) => e.event === "coordinator_time_warning") ? (
            <Banner
              className="rq-notice rq-notice--warn"
              status="warning"
              title="分析耗时较长，是否继续等待？"
              endContent={
                <Button
                  label="停止分析"
                  variant="destructive"
                  size="sm"
                  onClick={onCancel}
                />
              }
            />
          ) : null}
          {liveRows.length > 0 || running ? (
            <>
              {running && liveRows.length === 0 ? <ThinkingIndicator /> : null}
              {liveRows.length > 0 ? (
                <ProcessStreamRows rows={liveRows} running={running} />
              ) : null}
            </>
          ) : null}
          {error ? (
            <Banner
              className="rq-notice rq-notice--warn"
              status="error"
              title={error}
            />
          ) : null}
        </ChatMessageList>
      ) : (
        <div className="rq-empty">
          <Sparkles size={24} />
          <strong>描述一个需求</strong>
          <span>Coordinator 会用对话澄清范围，并在准备好后给出确认卡片。</span>
        </div>
      )}
    </AnchoredScroll>
  );
}

function RequirementTranscriptItem({
  item,
  projectId,
  continued,
}: {
  item: RequirementConversationItem;
  projectId: string;
  continued: boolean;
}) {
  if (item.kind === "process") {
    return (
      <ProcessStreamRows
        rows={buildProcessRowsFromTrace(
          traceFromMetadata(item.metadata) ?? {
            blocks: [],
            thinking: "",
            output: "",
            tools: [],
            statuses: [],
          },
        )}
      />
    );
  }

  if (item.kind === "notice") {
    return (
      <div className={`rq-notice rq-notice--${item.level}`}>
        {item.level === "warn" ? (
          <AlertTriangle size={14} />
        ) : (
          <Circle size={10} />
        )}
        <span>{item.text}</span>
      </div>
    );
  }

  return (
    <ChatMessageBubble
      role={item.kind}
      content={item.text}
      references={item.kind === "user" ? (item.references ?? []) : []}
      images={item.kind === "user" ? (item.images ?? []) : []}
      projectId={projectId}
      createdAt={item.created_at}
      assistantLabel="Coordinator"
      continued={continued}
    />
  );
}

function isContinuedItem(
  previous: RequirementConversationItem | undefined,
  current: RequirementConversationItem,
) {
  if (
    !previous ||
    (current.kind !== "user" && current.kind !== "assistant") ||
    previous.kind !== current.kind
  ) {
    return false;
  }
  return (
    Math.abs(
      Date.parse(current.created_at) - Date.parse(previous.created_at),
    ) <=
    5 * 60 * 1000
  );
}

function RequirementPromptLayer({ children }: { children: React.ReactNode }) {
  return <div className="rq-prompt-layer nowheel nodrag">{children}</div>;
}

function RequirementAskCard({
  prompt,
  answers,
  busy,
  onAnswerChange,
  onSubmit,
}: {
  prompt: Extract<RequirementConversationPrompt, { type: "clarification" }>;
  answers: Record<string, DraftClarificationAnswer>;
  busy: boolean;
  onAnswerChange: (
    clarification: RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  onSubmit: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const question = prompt.questions[activeIndex];
  const answer = question
    ? (answers[question.id] ?? createDraftAnswer(question))
    : undefined;
  const allAnswered = prompt.questions.every((item) =>
    hasDraftAnswer(item, answers[item.id] ?? createDraftAnswer(item)),
  );

  if (!question || !answer) {
    return null;
  }

  function advance() {
    if (activeIndex < prompt.questions.length - 1) {
      setActiveIndex(activeIndex + 1);
      return;
    }
    onSubmit();
  }

  return (
    <Card className="rq-shelf rq-ask" padding={4}>
      <div className="rq-shelf__topline">
        <span>澄清 · 第 {prompt.round} 轮</span>
        <span>
          {activeIndex + 1}/{prompt.questions.length}
        </span>
      </div>
      <div className="rq-ask__crumbs">
        {prompt.questions.map((item, index) => (
          <Button
            key={item.id}
            label={`${index + 1}`}
            size="sm"
            variant={index === activeIndex ? "primary" : "ghost"}
            className={`rq-ask__crumb ${index === activeIndex ? "is-active" : ""}`}
            onClick={() => setActiveIndex(index)}
            endContent={
              hasDraftAnswer(
                item,
                answers[item.id] ?? createDraftAnswer(item),
              ) ? (
                <Check size={11} />
              ) : null
            }
          />
        ))}
      </div>
      <strong>{question.question}</strong>
      {question.question_type === "free_text" ? (
        <TextArea
          label="补充说明"
          className="rq-ask__textarea"
          isLabelHidden
          value={answer.customText}
          onChange={(value) =>
            onAnswerChange(question, {
              ...answer,
              customText: value,
            })
          }
          placeholder="输入你的补充说明"
          rows={3}
        />
      ) : (
        <div className="rq-ask__options">
          {question.options.map((option) => {
            const selected = answer.selectedOptions.includes(option.value);
            return (
              <Button
                key={option.value}
                label={
                  option.description
                    ? `${option.label} ${option.description}`
                    : option.label
                }
                variant={selected ? "primary" : "secondary"}
                className={`rq-ask__option ${selected ? "is-selected" : ""}`}
                onClick={() => {
                  const next = toggleClarificationOption(
                    question,
                    answer,
                    option.value,
                  );
                  onAnswerChange(question, next);
                  if (
                    question.question_type === "single_choice" &&
                    activeIndex < prompt.questions.length - 1
                  ) {
                    setActiveIndex(activeIndex + 1);
                  }
                }}
              >
                <span>{option.label}</span>
                {option.description ? (
                  <small>{option.description}</small>
                ) : null}
              </Button>
            );
          })}
        </div>
      )}
      <div className="rq-shelf__actions">
        <Button
          label={
            activeIndex < prompt.questions.length - 1 ? "继续" : "提交澄清"
          }
          className="rq-shelf__action rq-shelf__action--primary"
          variant="primary"
          isDisabled={busy || !hasDraftAnswer(question, answer)}
          onClick={advance}
        />
        <Button
          label="全部提交"
          className="rq-shelf__action"
          variant="secondary"
          isDisabled={busy || !allAnswered}
          onClick={onSubmit}
        />
      </div>
    </Card>
  );
}

function RequirementConfirmCard({
  prompt,
  requirement,
  busy,
  onConfirm,
  onContinueEditing,
}: {
  prompt: Extract<RequirementConversationPrompt, { type: "confirmation" }>;
  requirement: Requirement;
  busy: boolean;
  onConfirm: () => void;
  onContinueEditing: () => void;
}) {
  return (
    <Card className="rq-shelf rq-confirm" padding={4}>
      <div className="rq-shelf__topline">
        <span>需求确认</span>
        <span>{requirementStatusText(requirement.status)}</span>
      </div>
      <strong>{prompt.draft.title}</strong>
      <p>{prompt.draft.summary}</p>
      <ul>
        {prompt.draft.acceptance_criteria.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="rq-shelf__actions">
        <Button
          label="确认并执行"
          className="rq-shelf__action rq-shelf__action--primary"
          variant="primary"
          isDisabled={busy}
          onClick={onConfirm}
        />
        <Button
          label="继续补充"
          className="rq-shelf__action"
          variant="secondary"
          isDisabled={busy}
          onClick={onContinueEditing}
        />
      </div>
    </Card>
  );
}
