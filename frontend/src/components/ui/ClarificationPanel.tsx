import React, { useState, useEffect } from "react";
import { Check, FileQuestion, Loader2, Send } from "lucide-react";
import type {
  Requirement,
  DraftClarificationAnswer,
  RequirementClarification,
} from "../../types/api";
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

  return (
    <section className="clarification-card">
      <div className="clarification-card__question">
        <span>{index + 1}</span>
        <div>
          <strong>{clarification.question}</strong>
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
  if (items.length === 0) return null;

  const safeStep = Math.min(step, items.length - 1);
  const current = items[safeStep];
  const currentAnswer = answers[current.id] ?? createDraftAnswer(current);
  const currentAnswered = hasDraftAnswer(current, currentAnswer);
  const allAnswered = items.every((item) =>
    hasDraftAnswer(item, answers[item.id]),
  );
  const isLast = safeStep === items.length - 1;
  const showSubmit =
    isLast ||
    current.question_type === "multi_choice" ||
    current.question_type === "free_text";
  const answeredSummary = items
    .slice(0, safeStep)
    .map((item, index) => {
      const answer = answers[item.id];
      if (!answer || !hasDraftAnswer(item, answer)) return null;
      const labels = answer.selectedOptions
        .map(
          (value) =>
            item.options.find((option) => option.value === value)?.label ??
            value,
        )
        .join("、");
      return {
        id: item.id,
        text: answer.customText.trim() || labels,
        index,
      };
    })
    .filter((item): item is { id: string; text: string; index: number } =>
      Boolean(item),
    );

  useEffect(() => {
    const firstUnanswered = items.findIndex(
      (item) => !hasDraftAnswer(item, answers[item.id]),
    );
    setStep(firstUnanswered === -1 ? 0 : firstUnanswered);
  }, [requirement.clarification_round]);

  function goToStep(index: number) {
    const target = items[index];
    if (
      !target ||
      (index > safeStep && !hasDraftAnswer(current, currentAnswer))
    ) {
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

  function updateCurrentAnswer(answer: DraftClarificationAnswer) {
    onAnswerChange(current, answer);
    if (
      current.question_type === "single_choice" &&
      hasDraftAnswer(current, answer) &&
      !isLast
    ) {
      setStep((value) => Math.min(value + 1, items.length - 1));
    }
  }

  return (
    <div className="clarification-panel">
      <div className="clarification-panel__head">
        <span>
          <FileQuestion size={15} />
          需要你确认
        </span>
        <em>
          第 {requirement.clarification_round} 轮 · {safeStep + 1}/
          {items.length}
        </em>
      </div>

      {answeredSummary.length > 0 ? (
        <div className="clarification-crumbs">
          {answeredSummary.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy}
              onClick={() => goToStep(item.index)}
            >
              <Check size={12} />
              {item.text}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className="clarification-panel__items"
        onWheel={(event) => event.stopPropagation()}
      >
        <ClarificationCard
          answer={currentAnswer}
          clarification={current}
          index={step}
          onChange={updateCurrentAnswer}
        />
      </div>

      <div className="clarification-panel__actions">
        {safeStep > 0 ? (
          <button
            className="clarification-panel__prev"
            disabled={busy}
            type="button"
            onClick={goPrev}
          >
            上一步
          </button>
        ) : null}
        {showSubmit ? (
          <button
            className="clarification-panel__next"
            disabled={busy || !currentAnswered}
            type="button"
            onClick={goNext}
          >
            {busy ? (
              <Loader2 size={14} className="spin-icon" />
            ) : (
              <Send size={14} />
            )}
            {busy ? "提交中" : isLast ? "提交澄清答案" : "继续"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
