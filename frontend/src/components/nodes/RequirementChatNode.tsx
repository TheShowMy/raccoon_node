import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, MessageSquare, X } from "lucide-react";
import type { StartNodeData } from "../../types/api";
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

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;
type ActiveCard = "requirement" | "project";
type ConfirmAction = "abandon-requirement" | "reset-project-chat";

export default function RequirementChatNode({ data }: { data: ChatData }) {
  const stackRef = useRef<HTMLDivElement>(null);
  const [activeCard, setActiveCard] = useState<ActiveCard>("requirement");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const conversation =
    data.conversation?.id === data.requirement?.id ? data.conversation : null;
  const prompt = data.promptDismissed ? null : (conversation?.prompt ?? null);

  useEffect(() => setActiveCard("requirement"), [data.project.id]);
  useEffect(() => setConfirmAction(null), [data.project.id]);

  function handleCardKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    const fromComposer =
      (target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement) &&
      target.closest(".rq-composer");
    if (
      event.key !== "Tab" ||
      (event.target !== event.currentTarget && !fromComposer)
    ) {
      return;
    }
    event.preventDefault();
    const next = activeCard === "requirement" ? "project" : "requirement";
    setActiveCard(next);
    requestAnimationFrame(() => {
      const input = stackRef.current?.querySelector<HTMLTextAreaElement>(
        `[data-chat-card="${next}"] textarea:not(:disabled)`,
      );
      (input ?? stackRef.current)?.focus();
    });
  }

  async function confirm() {
    const action = confirmAction;
    setConfirmAction(null);
    if (action === "abandon-requirement") {
      data.onAbandon();
    } else if (action === "reset-project-chat") {
      await data.onProjectChatReset();
    }
  }

  return (
    <>
      <div
        ref={stackRef}
        className="chat-card-stack nodrag"
        data-active-card={activeCard}
        tabIndex={0}
        aria-label="需求会话与项目问答"
        onKeyDown={handleCardKeyDown}
      >
        <ChatCard
          card="requirement"
          title="需求会话"
          active={activeCard === "requirement"}
          onActivate={() => setActiveCard("requirement")}
        >
          <RequirementConversationWorkbench
            conversation={conversation}
            requirement={data.requirement}
            projectName={data.project.name}
            projectId={data.project.id}
            prompt={prompt}
            promptDismissed={data.promptDismissed}
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
        </ChatCard>

        <ChatCard
          card="project"
          title="项目问答"
          active={activeCard === "project"}
          onActivate={() => setActiveCard("project")}
        >
          <ProjectChatWorkbench
            data={data}
            onReset={() => setConfirmAction("reset-project-chat")}
          />
        </ChatCard>
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

function ChatCard({
  card,
  title,
  active,
  onActivate,
  children,
}: {
  card: ActiveCard;
  title: string;
  active: boolean;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`chat-stack-card ${active ? "is-active" : ""}`}
      data-chat-card={card}
    >
      <button
        className="chat-stack-card__switch nodrag"
        type="button"
        aria-label={`切换到${title}`}
        tabIndex={active ? -1 : 0}
        onClick={onActivate}
      >
        <span>{title}</span>
      </button>
      <div
        className="chat-stack-card__body"
        inert={active ? undefined : true}
        aria-hidden={!active}
      >
        {children}
      </div>
    </section>
  );
}

function ProjectChatWorkbench({
  data,
  onReset,
}: {
  data: ChatData;
  onReset: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const running = data.projectChat?.running ?? false;
  const error = data.projectChatError ?? data.projectChat?.error ?? null;
  const liveBubbles = useMemo(
    () => buildBubbleStreamFromEvents(data.projectChatEvents),
    [data.projectChatEvents],
  );
  const streamingText = useMemo(
    () => buildStreamingTextFromEvents(data.projectChatEvents),
    [data.projectChatEvents],
  );
  const transientEvents = data.projectChatEvents.filter(
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

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [
    data.projectChat?.messages.length,
    data.projectChat?.updated_at,
    data.projectChatEvents.length,
    liveBubbles.length,
  ]);

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
        <div ref={transcriptRef} className="rq-transcript nowheel nodrag">
          {data.projectChat?.messages.length ||
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
        </div>

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
        />
      </div>
    </>
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
