import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, MessageSquare, X } from "lucide-react";
import type {
  ConversationEvent,
  ProjectChatMessage,
  RequirementDraft,
  StartNodeData,
  StreamEvent,
} from "../../types/api";
import {
  buildBubbleStreamFromEvents,
  buildBubbleStreamFromTrace,
  buildStreamingTextFromEvents,
  traceFromMetadata,
} from "../../utils/format";
import RequirementConversationWorkbench from "../requirements/RequirementConversation";
import ChatComposer from "../ui/ChatComposer";
import ChatMessageBubble from "../ui/ChatMessageBubble";
import LiveProcessCard from "../ui/LiveProcessCard";
import AnchoredScroll from "../ui/AnchoredScroll";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;
type ActiveCard = "requirement" | "project";
type ConfirmAction = "abandon-requirement" | "reset-project-chat";

export default function RequirementChatNode({ data }: { data: ChatData }) {
  const [activeCard, setActiveCard] = useState<ActiveCard>("requirement");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const conversation =
    data.conversation?.id === data.requirement?.id ? data.conversation : null;
  const prompt = data.promptDismissed ? null : (conversation?.prompt ?? null);

  useEffect(() => setActiveCard("requirement"), [data.project.id]);
  useEffect(() => setConfirmAction(null), [data.project.id]);

  async function confirm() {
    const action = confirmAction;
    setConfirmAction(null);
    if (action === "abandon-requirement") {
      data.onAbandon();
    } else if (action === "reset-project-chat") {
      await data.onProjectChatReset();
    }
  }

  function continueWithSummary(summary: RequirementDraft) {
    setActiveCard("requirement");
    data.onInputChange(formatRequirementSummary(summary));
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>(
          '[data-chat-card="requirement"] textarea:not(:disabled)',
        )
        ?.focus();
    });
  }

  return (
    <>
      <div className="chat-workspace nodrag" aria-label="需求会话与项目问答">
        <div className="chat-workspace__tabs" role="tablist">
          {(
            [
              ["requirement", "需求会话"],
              ["project", "项目问答"],
            ] as const
          ).map(([card, title]) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeCard === card}
              className={activeCard === card ? "is-active" : ""}
              onClick={() => setActiveCard(card)}
              key={card}
            >
              {title}
            </button>
          ))}
        </div>
        <section
          className="chat-workspace__panel"
          data-chat-card="requirement"
          hidden={activeCard !== "requirement"}
          inert={activeCard === "requirement" ? undefined : true}
        >
          <RequirementConversationWorkbench
            conversation={conversation}
            requirement={data.requirement}
            projectName={data.project.name}
            projectId={data.project.id}
            prompt={prompt}
            input={data.input}
            references={data.references ?? []}
            images={data.images ?? []}
            busy={data.busy}
            error={data.error}
            streamEvents={data.streamEvents}
            answers={data.answers}
            onInputChange={data.onInputChange}
            onReferencesChange={data.onReferencesChange ?? (() => {})}
            onImagesChange={data.onImagesChange ?? (() => {})}
            onSend={data.onSend}
            onAnswerChange={data.onAnswerChange}
            onSubmitClarifications={data.onSubmitClarifications}
            onConfirm={data.onConfirm}
            onRetryAnalysis={data.onRetryAnalysis}
            onContinueEditing={data.onContinueEditing}
            onCancel={data.onCancel}
            onAbandon={() => setConfirmAction("abandon-requirement")}
          />
        </section>
        <section
          className="chat-workspace__panel"
          data-chat-card="project"
          hidden={activeCard !== "project"}
          inert={activeCard === "project" ? undefined : true}
        >
          <ProjectChatWorkbench
            data={data}
            onReset={() => setConfirmAction("reset-project-chat")}
            onContinueWithSummary={continueWithSummary}
          />
        </section>
      </div>
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

function ProjectChatWorkbench({
  data,
  onReset,
  onContinueWithSummary,
}: {
  data: ChatData;
  onReset: () => void;
  onContinueWithSummary: (summary: RequirementDraft) => void;
}) {
  const running = data.projectChat?.running ?? false;
  const error = data.projectChatError ?? data.projectChat?.error ?? null;
  const streamEvents = useMemo(
    () => data.projectChatEvents.map(projectEventToStreamEvent),
    [data.projectChatEvents],
  );
  const liveBubbles = useMemo(
    () => buildBubbleStreamFromEvents(streamEvents),
    [streamEvents],
  );
  const streamingText = useMemo(
    () => buildStreamingTextFromEvents(streamEvents),
    [streamEvents],
  );
  const transientEvents = streamEvents.filter(
    (event) =>
      event.event !== "pi_event" &&
      ![
        "project_chat_started",
        "project_chat_completed",
        "project_chat_failed",
        "chat_started",
        "chat_updated",
        "chat_completed",
        "chat_failed",
        "started",
        "completed",
        "failed",
      ].includes(event.event),
  );
  const canSend =
    !data.projectChatBusy &&
    !running &&
    data.projectChatInput.trim().length > 0;

  return (
    <>
      <div className="node-header node-header--projects">
        <span className="node-icon">
          <MessageSquare size={20} />
        </span>
        <div>
          <strong>项目问答</strong>
          <span>
            {data.project.name} · {running ? "Pi Agent 处理中" : "随时可问"}
          </span>
        </div>
        <button
          type="button"
          className="node-header__action"
          disabled={data.projectChatBusy || running}
          aria-label="关闭项目问答会话"
          title="关闭项目问答会话"
          onClick={onReset}
        >
          <X size={15} />
        </button>
      </div>

      <div className="rq-workbench project-chat-workbench">
        <AnchoredScroll
          className="rq-transcript nowheel nodrag"
          version={`${data.projectChat?.updated_at ?? "empty"}:${data.projectChatEvents.length}`}
        >
          {data.projectChat?.messages.length ||
          data.projectChat?.requirement_summary ||
          (running && liveBubbles.length) ||
          transientEvents.length ||
          running ||
          error ? (
            <div className="rq-transcript__items">
              {data.projectChat?.messages.map((message, index) => (
                <Fragment key={`${message.created_at}-${index}`}>
                  <ChatMessageBubble
                    role={message.role}
                    content={message.content}
                    references={message.references ?? []}
                    images={message.images ?? []}
                    projectId={data.project.id}
                    createdAt={message.created_at}
                    assistantLabel="Pi Agent"
                    continued={isContinuedProjectMessage(
                      data.projectChat?.messages[index - 1],
                      message,
                    )}
                  >
                    {message.role === "assistant" && message.metadata ? (
                      <LiveProcessCard
                        title="回答过程"
                        status="done"
                        bubbles={buildBubbleStreamFromTrace(
                          traceFromMetadata(message.metadata) ?? {
                            thinking: "",
                            output: "",
                            tools: [],
                            statuses: [],
                          },
                        )}
                      />
                    ) : null}
                  </ChatMessageBubble>
                </Fragment>
              ))}
              {data.projectChat?.requirement_summary ? (
                <RequirementSummaryCard
                  summary={data.projectChat.requirement_summary}
                  disabled={data.projectChatBusy || running}
                  onContinue={() =>
                    onContinueWithSummary(
                      data.projectChat!.requirement_summary!,
                    )
                  }
                />
              ) : null}
              {transientEvents.length > 0 ? (
                <div className="rq-notice rq-notice--info">
                  {transientEvents.at(-1)?.message}
                </div>
              ) : null}
              {running ? (
                <ChatMessageBubble
                  role="assistant"
                  content={streamingText}
                  createdAt={
                    data.projectChat?.updated_at ?? new Date().toISOString()
                  }
                  assistantLabel="Pi Agent"
                >
                  <LiveProcessCard
                    title="正在回答"
                    status="running"
                    bubbles={liveBubbles}
                    live
                  />
                </ChatMessageBubble>
              ) : null}
              {error ? (
                <div className="rq-notice rq-notice--warn" role="alert">
                  {error}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rq-empty">
              <MessageSquare size={24} />
              <strong>询问当前项目</strong>
              <span>消息会持久保存，Pi Agent 过程会在这里实时显示。</span>
            </div>
          )}
        </AnchoredScroll>

        <ChatComposer
          value={data.projectChatInput}
          projectId={data.project.id}
          references={data.projectChatReferences ?? []}
          images={data.projectChatImages ?? []}
          onReferencesChange={data.onProjectChatReferencesChange ?? (() => {})}
          onImagesChange={data.onProjectChatImagesChange ?? (() => {})}
          disabled={data.projectChatBusy || running}
          canSend={canSend}
          placeholder={
            running ? "Pi Agent 正在处理..." : "询问项目代码、结构或实现..."
          }
          sendLabel="发送项目问答"
          onChange={data.onProjectChatInputChange}
          onSubmit={data.onProjectChatSend}
          onStop={running ? () => void data.onProjectChatAbort() : undefined}
          stopLabel="停止项目问答"
          onGenerateRequirementSummary={data.onProjectChatGenerateRequirement}
        />
      </div>
    </>
  );
}

function RequirementSummaryCard({
  summary,
  disabled,
  onContinue,
}: {
  summary: RequirementDraft;
  disabled: boolean;
  onContinue: () => void;
}) {
  return (
    <section className="rq-shelf rq-confirm" aria-label="需求说明">
      <div className="rq-shelf__topline">
        <span>需求说明</span>
      </div>
      <strong>{summary.title}</strong>
      <p>{summary.summary}</p>
      <ul>
        {summary.acceptance_criteria.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="rq-shelf__actions">
        <button type="button" disabled={disabled} onClick={onContinue}>
          作为需求继续
        </button>
      </div>
    </section>
  );
}

function formatRequirementSummary(summary: RequirementDraft) {
  const criteria = summary.acceptance_criteria
    .map((item) => `- ${item}`)
    .join("\n");
  return `# ${summary.title}\n\n${summary.summary}\n\n## 验收标准\n\n${criteria}`;
}

function projectEventToStreamEvent(event: ConversationEvent): StreamEvent {
  const payload =
    event.payload.event && typeof event.payload.event === "object"
      ? event.payload.event
      : event.payload.payload && typeof event.payload.payload === "object"
        ? event.payload.payload
        : event.payload;
  const delta =
    typeof event.payload.delta === "string" ? event.payload.delta : "";
  const message =
    typeof event.payload.message === "string" ? event.payload.message : delta;
  const assistantType =
    event.type === "assistant.thinking.delta" ? "thinking_delta" : "text_delta";
  const normalizedPayload =
    event.type.startsWith("assistant.") &&
    !("assistantMessageEvent" in (payload as Record<string, unknown>))
      ? { assistantMessageEvent: { type: assistantType, delta } }
      : payload;
  const piType =
    typeof event.payload.pi_type === "string"
      ? event.payload.pi_type
      : event.type.startsWith("assistant.")
        ? "message_update"
        : event.type === "tool.start"
          ? "tool_execution_start"
          : event.type === "tool.update"
            ? "tool_execution_update"
            : event.type === "tool.end"
              ? "tool_execution_end"
              : undefined;
  return {
    requirement_id: String(event.payload.project_id ?? "current"),
    event: piType ? "pi_event" : event.type,
    message,
    pi_type: piType,
    payload: normalizedPayload,
  };
}

function isContinuedProjectMessage(
  previous: ProjectChatMessage | undefined,
  current: ProjectChatMessage,
) {
  return Boolean(
    previous &&
    previous.role === current.role &&
    Math.abs(
      Date.parse(current.created_at) - Date.parse(previous.created_at),
    ) <=
      5 * 60 * 1000,
  );
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
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  if (!open) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="chat-confirm-dialog"
      onClose={onCancel}
      onClick={onCancel}
    >
      <section
        className="node-card chat-confirm-dialog__panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="chat-confirm-dialog__icon">
          <AlertTriangle size={22} />
        </div>
        <div>
          <strong>{title}</strong>
          <p>{description}</p>
        </div>
        <div className="chat-confirm-dialog__actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="is-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </dialog>,
    document.body,
  );
}
