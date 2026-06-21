import React, { useState, useEffect } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileQuestion,
  Loader2,
  Send,
} from "lucide-react";
import type {
  Requirement,
  DraftClarificationAnswer,
  RequirementClarification,
} from "../../types/api";
import { stopWheelPropagation } from "../../utils/events";
import {
  createDraftAnswer,
  hasDraftAnswer,
  toggleClarificationOption,
} from "../../utils/format";

function ClarificationCard({
  clarification,
  index,
  answer,
  onChange,
}: {
  clarification: RequirementClarification;
  index: number;
  answer: DraftClarificationAnswer;
  onChange: (answer: DraftClarificationAnswer) => void;
}) {
  const isFreeText = clarification.question_type === "free_text";
  const questionTypeLabel =
    clarification.question_type === "single_choice"
      ? "单选"
      : clarification.question_type === "multi_choice"
        ? "多选"
        : "填空";

  return (
    <section className="clarification-card">
      <div className="clarification-card__question">
        <span>Q{index + 1}</span>
        <div>
          <strong>{clarification.question}</strong>
          <em>{questionTypeLabel}</em>
        </div>
      </div>
      {isFreeText ? (
        <textarea
          value={answer.customText}
          onChange={(event) =>
            onChange({ ...answer, customText: event.target.value })
          }
          placeholder="补充你的答案..."
        />
      ) : (
        <div className="clarification-options">
          {clarification.options.map((option) => {
            const checked = answer.selectedOptions.includes(option.value);
            return (
              <button
                aria-pressed={checked}
                className={`clarification-option clarification-option--${clarification.question_type} ${
                  checked ? "clarification-option--selected" : ""
                }`}
                key={option.value}
                type="button"
                onClick={() =>
                  onChange(
                    toggleClarificationOption(
                      clarification,
                      answer,
                      option.value,
                    ),
                  )
                }
              >
                <i aria-hidden="true">
                  {checked && clarification.question_type === "multi_choice" ? (
                    <Check size={12} />
                  ) : null}
                </i>
                <span>
                  {option.label}
                  {option.recommended ? <em>推荐</em> : null}
                </span>
                <small>{option.description}</small>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function ClarificationPanel({
  requirement,
  answers,
  busy,
  onAnswerChange,
  onSubmit,
}: {
  requirement: Requirement;
  answers: Record<string, DraftClarificationAnswer>;
  busy: boolean;
  onAnswerChange: (
    clarification: RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  onSubmit: () => void;
}) {
  const [step, setStep] = useState(0);
  const items = requirement.clarifications;
  const current = items[step];
  const currentAnswer = answers[current.id] ?? createDraftAnswer(current);
  const currentAnswered = hasDraftAnswer(current, currentAnswer);
  const allAnswered = items.every((item) =>
    hasDraftAnswer(item, answers[item.id]),
  );
  const isLast = step === items.length - 1;

  useEffect(() => {
    const firstUnanswered = items.findIndex(
      (item) => !hasDraftAnswer(item, answers[item.id]),
    );
    setStep(firstUnanswered === -1 ? 0 : firstUnanswered);
  }, [requirement.clarification_round]);

  function goToStep(index: number) {
    const target = items[index];
    if (!target || (index > step && !hasDraftAnswer(current, currentAnswer))) {
      return;
    }
    setStep(index);
  }

  function goNext() {
    if (!currentAnswered) return;
    if (isLast) {
      if (allAnswered) onSubmit();
      return;
    }
    setStep((value) => Math.min(value + 1, items.length - 1));
  }

  function goPrev() {
    setStep((value) => Math.max(value - 1, 0));
  }

  return (
    <div className="clarification-panel">
      <div className="clarification-panel__head">
        <span>
          <FileQuestion size={15} />
          需要你确认
        </span>
        <em>
          第 {requirement.clarification_round} 轮澄清 ({step + 1}/{items.length}
          )
        </em>
      </div>

      <div className="clarification-steps">
        {items.map((item, index) => {
          const answered = hasDraftAnswer(item, answers[item.id]);
          const status =
            index === step ? "current" : answered ? "completed" : "pending";
          return (
            <button
              className={`clarification-step clarification-step--${status}`}
              disabled={busy || (!answered && index !== step)}
              key={item.id}
              type="button"
              onClick={() => goToStep(index)}
            >
              {answered && index !== step ? <Check size={12} /> : index + 1}
            </button>
          );
        })}
      </div>

      <div
        className="clarification-panel__items"
        onWheel={stopWheelPropagation}
      >
        <ClarificationCard
          answer={currentAnswer}
          clarification={current}
          index={step}
          onChange={(answer) => onAnswerChange(current, answer)}
        />
      </div>

      <div className="clarification-panel__actions">
        <button
          className="clarification-panel__prev"
          disabled={busy || step === 0}
          type="button"
          onClick={goPrev}
        >
          <ChevronLeft size={14} />
          上一步
        </button>
        <button
          className="clarification-panel__next"
          disabled={busy || !currentAnswered}
          type="button"
          onClick={goNext}
        >
          {busy ? (
            <Loader2 size={14} className="spin-icon" />
          ) : isLast ? (
            <Send size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
          {busy ? "提交中" : isLast ? "提交澄清答案" : "下一步"}
        </button>
      </div>
    </div>
  );
}
