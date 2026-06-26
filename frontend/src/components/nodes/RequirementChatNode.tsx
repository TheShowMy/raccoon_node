import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
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
          onAbandon={data.onAbandon}
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
