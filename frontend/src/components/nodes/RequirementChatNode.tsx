import { useEffect, useRef, useState } from "react";
import { Bot, MessageSquare, Send, User } from "lucide-react";
import type {
  ProjectChatEvent,
  ProjectChatMessage,
  StartNodeData,
} from "../../types/api";
import { formatDate } from "../../utils/format";
import RequirementConversationWorkbench from "../requirements/RequirementConversation";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;
type ActiveCard = "requirement" | "project";

export default function RequirementChatNode({ data }: { data: ChatData }) {
  const [activeCard, setActiveCard] = useState<ActiveCard>("requirement");
  const conversation =
    data.conversation?.id === data.requirement?.id ? data.conversation : null;
  const prompt = data.promptDismissed ? null : (conversation?.prompt ?? null);

  useEffect(() => setActiveCard("requirement"), [data.project.id]);

  return (
    <div className="chat-card-stack" data-active-card={activeCard}>
      <ChatCard
        title="需求会话"
        active={activeCard === "requirement"}
        onActivate={() => setActiveCard("requirement")}
      >
        <RequirementConversationWorkbench
          conversation={conversation}
          requirement={data.requirement}
          projectName={data.project.name}
          prompt={prompt}
          promptDismissed={data.promptDismissed}
          input={data.input}
          busy={data.busy}
          error={data.error}
          streamEvents={data.streamEvents}
          answers={data.answers}
          onInputChange={data.onInputChange}
          onSend={data.onSend}
          onAnswerChange={data.onAnswerChange}
          onSubmitClarifications={data.onSubmitClarifications}
          onConfirm={data.onConfirm}
          onContinueEditing={data.onContinueEditing}
          onCancel={data.onCancel}
        />
      </ChatCard>

      <ChatCard
        title="项目问答"
        active={activeCard === "project"}
        onActivate={() => setActiveCard("project")}
      >
        <ProjectChatWorkbench data={data} />
      </ChatCard>
    </div>
  );
}

function ChatCard({
  title,
  active,
  onActivate,
  children,
}: {
  title: string;
  active: boolean;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`chat-stack-card ${active ? "is-active" : ""}`}>
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

function ProjectChatWorkbench({ data }: { data: ChatData }) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const running = data.projectChat?.running ?? false;
  const error = data.projectChatError ?? data.projectChat?.error ?? null;
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
      </div>

      <div className="rq-workbench project-chat-workbench">
        <div ref={transcriptRef} className="rq-transcript nowheel nodrag">
          {data.projectChat?.messages.length ||
          data.projectChatEvents.length ||
          error ? (
            <div className="rq-transcript__items">
              {data.projectChat?.messages.map((message, index) => (
                <ProjectChatMessageView
                  key={`${message.created_at}-${index}`}
                  message={message}
                />
              ))}
              {data.projectChatEvents.length > 0 ? (
                <ProjectChatEvents events={data.projectChatEvents} />
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

        <form
          className="rq-composer nowheel nodrag"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) void data.onProjectChatSend();
          }}
        >
          <textarea
            value={data.projectChatInput}
            disabled={data.projectChatBusy || running}
            onChange={(event) =>
              data.onProjectChatInputChange(event.target.value)
            }
            placeholder={
              running ? "Pi Agent 正在处理..." : "询问项目代码、结构或实现..."
            }
            rows={1}
          />
          <button type="submit" disabled={!canSend} aria-label="发送项目问答">
            <Send size={15} />
          </button>
        </form>
      </div>
    </>
  );
}

function ProjectChatMessageView({ message }: { message: ProjectChatMessage }) {
  return (
    <article className={`rq-message rq-message--${message.role}`}>
      <div className="rq-message__avatar">
        {message.role === "user" ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className="rq-message__body">
        <div className="rq-message__meta">
          <span>
            {message.role === "user"
              ? "你"
              : message.role === "assistant"
                ? "Pi Agent"
                : "系统"}
          </span>
          <time dateTime={message.created_at}>
            {formatDate(message.created_at)}
          </time>
        </div>
        <p>{message.content}</p>
      </div>
    </article>
  );
}

function ProjectChatEvents({ events }: { events: ProjectChatEvent[] }) {
  return (
    <section className="project-chat-events" aria-label="实时 Pi 事件">
      <strong>实时 Pi 事件</strong>
      {events.map((event, index) => (
        <div key={`${event.event}-${index}`} className="project-chat-event">
          <span>{event.pi_type ?? event.event}</span>
          <p>{event.message}</p>
          {event.payload === undefined ? null : (
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
          )}
        </div>
      ))}
    </section>
  );
}
