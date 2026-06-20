import React, { useEffect, useRef } from "react";
import { MessageSquare, Loader2, Send } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import {
  requirementStatusText,
  buildBubbleStreamFromEvents,
} from "../../utils/format";
import RequirementMessageBubble from "./RequirementMessageBubble";
import TraceBubble from "../ui/TraceBubble";
import ClarificationPanel from "../ui/ClarificationPanel";

export default function RequirementChatNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-chat" }>;
}) {
  const requirement = data.requirement;
  const canConfirm = requirement?.status === "draft_ready" && requirement.draft;
  const isAnalyzing = requirement?.status === "analyzing";
  const canSend =
    !data.busy &&
    !isAnalyzing &&
    data.input.trim().length > 0 &&
    (!requirement ||
      ["analyzing", "clarifying", "draft_ready", "failed"].includes(
        requirement.status,
      ));
  const liveBubbles = buildBubbleStreamFromEvents(data.streamEvents);
  const transientEvents = data.streamEvents.filter(
    (event) => event.event !== "pi_event",
  );
  const scrollableRef = useRef<HTMLDivElement>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSend) {
      await data.onSend();
    }
  }

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      const target = event.target as Node;
      const node = scrollableRef.current;
      if (!node || !node.contains(target)) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
    };

    document.addEventListener("wheel", handleWheel, {
      passive: false,
      capture: true,
    });
    return () => {
      document.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, []);

  useEffect(() => {
    const element = scrollableRef.current;
    if (!element) return;

    const handleWheel = (event: WheelEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };

    element.addEventListener("wheel", handleWheel, {
      passive: false,
      capture: true,
    });
    return () => {
      element.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, []);

  useEffect(() => {
    const element = scrollableRef.current;
    if (!element) return;

    const isNearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    if (isNearBottom) {
      element.scrollTop = element.scrollHeight;
    }
  }, [requirement?.messages.length, data.streamEvents.length]);

  return (
    <>
      <div className="node-header node-header--model">
        <span className="node-icon">
          <MessageSquare size={20} />
        </span>
        <div>
          <strong>需求</strong>
          <span>
            {requirement
              ? requirementStatusText(requirement.status)
              : "新的需求会话"}
          </span>
        </div>
      </div>
      <div className="requirement-chat">
        <div ref={scrollableRef} className="requirement-chat__scrollable">
          {requirement ? (
            <div className="requirement-messages">
              {requirement.messages.map((message) => (
                <RequirementMessageBubble
                  key={`${message.role}-${message.created_at}-${message.content}`}
                  message={message}
                />
              ))}
            </div>
          ) : (
            <div className="requirement-empty">
              <MessageSquare size={24} />
              <strong>新的需求会话</strong>
              <span>描述你的需求，Coordinator 会先澄清并生成确认卡片。</span>
            </div>
          )}

          {transientEvents.length > 0 ? (
            <div className="requirement-events">
              {transientEvents.map((event, index) => (
                <span key={`${event.event}-${index}`}>{event.message}</span>
              ))}
            </div>
          ) : null}

          {liveBubbles.length > 0 ? (
            <TraceBubble bubbles={liveBubbles} isLive={isAnalyzing} />
          ) : isAnalyzing ? (
            <div className="requirement-analyzing">
              <Loader2 size={16} />
              Coordinator 正在分析当前需求...
            </div>
          ) : null}

          {requirement?.status === "clarifying" &&
          requirement.clarifications.length > 0 ? (
            <ClarificationPanel
              requirement={requirement}
              answers={data.answers}
              busy={data.busy}
              onAnswerChange={data.onAnswerChange}
              onSubmit={() => void data.onSubmitClarifications(requirement)}
            />
          ) : null}

          {requirement?.draft ? (
            <div className="requirement-draft">
              <div>
                <strong>{requirement.draft.title}</strong>
                <p>{requirement.draft.summary}</p>
              </div>
              <ul>
                {requirement.draft.acceptance_criteria.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <button
                className="model-actions__save"
                type="button"
                disabled={data.busy || !canConfirm}
                onClick={() => requirement && void data.onConfirm(requirement)}
              >
                确认并加入执行队列
              </button>
            </div>
          ) : null}

          {requirement?.error ? (
            <p className="form-error">{requirement.error}</p>
          ) : null}
          {data.error ? <p className="form-error">{data.error}</p> : null}
        </div>

        <form className="requirement-input" onSubmit={submit}>
          <textarea
            id="requirement-input"
            name="requirement-input"
            value={data.input}
            disabled={data.busy}
            onChange={(event) => data.onInputChange(event.target.value)}
            placeholder={
              requirement
                ? isAnalyzing
                  ? "Coordinator 正在分析，过程会实时显示..."
                  : "补充说明你的需求..."
                : "描述你的需求，Coordinator 会用聊天形式澄清..."
            }
            rows={1}
          />
          <button type="submit" disabled={!canSend}>
            <Send size={15} />
            {data.busy ? "分析中" : "发送"}
          </button>
        </form>
      </div>
    </>
  );
}
