import React, { useEffect, useMemo, useRef, useState } from "react";
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
  StreamEvent,
} from "../../types/api";
import {
  buildBubbleStreamFromEvents,
  buildBubbleStreamFromTrace,
  createDraftAnswer,
  hasDraftAnswer,
  requirementStatusText,
  toggleClarificationOption,
  traceFromMetadata,
} from "../../utils/format";
import ChatComposer from "../ui/ChatComposer";
import ChatMessageBubble from "../ui/ChatMessageBubble";
import LiveProcessCard from "../ui/LiveProcessCard";

type Props = {
  conversation: RequirementConversation | null;
  requirement: Requirement | null;
  projectName: string;
  prompt: RequirementConversationPrompt | null;
  promptDismissed: boolean;
  input: string;
  busy: boolean;
  error: string | null;
  streamEvents: StreamEvent[];
  answers: Record<string, DraftClarificationAnswer>;
  onInputChange: (value: string) => void;
  onSend: () => Promise<void>;
  onAnswerChange: (
    clarification: RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  onSubmitClarifications: (requirement: Requirement) => Promise<void>;
  onConfirm: (requirement: Requirement) => Promise<void>;
  onContinueEditing: (requirement: Requirement) => void;
  onCancel: () => void;
  onAbandon: () => void;
};

export default function RequirementConversationWorkbench({
  conversation,
  requirement,
  projectName,
  prompt,
  promptDismissed,
  input,
  busy,
  error,
  streamEvents,
  answers,
  onInputChange,
  onSend,
  onAnswerChange,
  onSubmitClarifications,
  onConfirm,
  onContinueEditing,
  onCancel,
  onAbandon,
}: Props) {
  const running =
    conversation?.running ??
    (requirement ? requirement.status === "analyzing" : false);
  const hasBlockingPrompt = Boolean(prompt);
  const canSend =
    !busy &&
    !running &&
    !hasBlockingPrompt &&
    input.trim().length > 0 &&
    (!requirement ||
      ["analyzing", "clarifying", "draft_ready", "failed"].includes(
        requirement.status,
      ) ||
      promptDismissed);

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
          <button
            type="button"
            className="node-header__action rq-abandon-btn"
            disabled={busy}
            aria-label="放弃当前需求"
            title="放弃当前需求"
            onClick={() => {
              if (
                window.confirm("确定要放弃当前需求？已输入的内容将不会保留。")
              ) {
                onAbandon();
              }
            }}
          >
            <X size={15} />
          </button>
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
          disabled={busy || running || hasBlockingPrompt}
          canSend={canSend}
          placeholder={
            hasBlockingPrompt
              ? "先处理上方卡片，或选择继续补充"
              : running
                ? "Coordinator 正在处理，过程会实时显示"
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveBubbles = useMemo(
    () => buildBubbleStreamFromEvents(streamEvents),
    [streamEvents],
  );
  const transientEvents = streamEvents.filter(
    (event) => event.event !== "pi_event",
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    conversation?.updated_at,
    conversation?.items.length,
    liveBubbles.length,
    streamEvents.length,
  ]);

  return (
    <div ref={scrollRef} className="rq-transcript nowheel nodrag">
      {conversation ? (
        <div className="rq-transcript__items">
          {conversation.items.map((item) => (
            <RequirementTranscriptItem key={item.id} item={item} />
          ))}
          {transientEvents.length > 0 ? (
            <div className="rq-notice rq-notice--info">
              {transientEvents.at(-1)?.message}
            </div>
          ) : null}
          {streamEvents.some((e) => e.event === "coordinator_time_warning") ? (
            <div className="rq-notice rq-notice--warn" role="alert">
              <span>分析耗时较长，是否继续等待？</span>
              <button
                className="rq-btn rq-btn--danger"
                type="button"
                onClick={onCancel}
              >
                停止分析
              </button>
            </div>
          ) : null}
          {liveBubbles.length > 0 || running ? (
            <LiveProcessCard
              title="Coordinator 正在处理"
              status={running ? "running" : "done"}
              bubbles={liveBubbles}
              live
            />
          ) : null}
          {error ? (
            <div className="rq-notice rq-notice--warn">{error}</div>
          ) : null}
        </div>
      ) : (
        <div className="rq-empty">
          <Sparkles size={24} />
          <strong>描述一个需求</strong>
          <span>Coordinator 会用对话澄清范围，并在准备好后给出确认卡片。</span>
        </div>
      )}
    </div>
  );
}

function RequirementTranscriptItem({
  item,
}: {
  item: RequirementConversationItem;
}) {
  if (item.kind === "process") {
    return (
      <LiveProcessCard
        title={item.title}
        status={item.status}
        bubbles={buildBubbleStreamFromTrace(
          traceFromMetadata(item.metadata) ?? {
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
      createdAt={item.created_at}
      assistantLabel="Coordinator"
    />
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
    <section className="rq-shelf rq-ask">
      <div className="rq-shelf__topline">
        <span>澄清 · 第 {prompt.round} 轮</span>
        <span>
          {activeIndex + 1}/{prompt.questions.length}
        </span>
      </div>
      <div className="rq-ask__crumbs">
        {prompt.questions.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className={index === activeIndex ? "is-active" : ""}
            onClick={() => setActiveIndex(index)}
          >
            {index + 1}
            {hasDraftAnswer(
              item,
              answers[item.id] ?? createDraftAnswer(item),
            ) ? (
              <Check size={11} />
            ) : null}
          </button>
        ))}
      </div>
      <strong>{question.question}</strong>
      {question.question_type === "free_text" ? (
        <textarea
          value={answer.customText}
          onChange={(event) =>
            onAnswerChange(question, {
              ...answer,
              customText: event.target.value,
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
              <button
                key={option.value}
                type="button"
                className={selected ? "is-selected" : ""}
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
              </button>
            );
          })}
        </div>
      )}
      <div className="rq-shelf__actions">
        <button
          type="button"
          disabled={busy || !hasDraftAnswer(question, answer)}
          onClick={advance}
        >
          {activeIndex < prompt.questions.length - 1 ? "继续" : "提交澄清"}
        </button>
        <button
          type="button"
          disabled={busy || !allAnswered}
          onClick={onSubmit}
        >
          全部提交
        </button>
      </div>
    </section>
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
    <section className="rq-shelf rq-confirm">
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
        <button type="button" disabled={busy} onClick={onConfirm}>
          确认并执行
        </button>
        <button type="button" disabled={busy} onClick={onContinueEditing}>
          继续补充
        </button>
      </div>
    </section>
  );
}
