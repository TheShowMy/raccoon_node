import { useEffect, useMemo, useState } from "react";
import {
  Card,
  HStack,
  List,
  ListItem,
  Text,
  TextArea,
  VStack,
} from "@astryxdesign/core";
import { Button } from "@astryxdesign/core/Button";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { Check } from "lucide-react";
import type {
  DraftClarificationAnswer,
  Requirement,
  RequirementClarification,
  RequirementConversationPrompt,
  RequirementDraft,
} from "../../types/api";
import {
  createDraftAnswer,
  hasDraftAnswer,
  requirementStatusText,
  toggleClarificationOption,
} from "../../utils/format";

type Props = {
  prompt: RequirementConversationPrompt | null;
  requirement: Requirement | null;
  summary: RequirementDraft | null;
  answers: Record<string, DraftClarificationAnswer>;
  busy: boolean;
  onAnswerChange: (
    clarification: RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  onSubmitClarifications: (requirement: Requirement) => void;
  onConfirm: (requirement: Requirement) => void;
  onContinueEditing: (requirement: Requirement) => void;
  onContinueWithSummary: (summary: RequirementDraft) => void;
};

export default function RequirementCardPanel({
  prompt,
  requirement,
  summary,
  answers,
  busy,
  onAnswerChange,
  onSubmitClarifications,
  onConfirm,
  onContinueEditing,
  onContinueWithSummary,
}: Props) {
  if (prompt && requirement) {
    return prompt.type === "clarification" ? (
      <AskCard
        prompt={prompt}
        requirement={requirement}
        answers={answers}
        busy={busy}
        onAnswerChange={onAnswerChange}
        onSubmit={() => onSubmitClarifications(requirement)}
      />
    ) : (
      <ConfirmCard
        prompt={prompt}
        requirement={requirement}
        busy={busy}
        onConfirm={() => onConfirm(requirement)}
        onContinueEditing={() => onContinueEditing(requirement)}
      />
    );
  }

  if (summary) {
    return (
      <SummaryCard
        summary={summary}
        busy={busy}
        onContinue={() => onContinueWithSummary(summary)}
      />
    );
  }

  return null;
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <Toolbar
      label={title}
      dividers={["bottom"]}
      startContent={
        <VStack gap={0}>
          <Text type="label" weight="semibold">
            {title}
          </Text>
          {subtitle ? (
            <Text type="supporting" size="2xs" color="secondary">
              {subtitle}
            </Text>
          ) : null}
        </VStack>
      }
    />
  );
}

function DraftBody({ draft }: { draft: RequirementDraft }) {
  return (
    <VStack gap={3} align="stretch">
      <Text type="body" size="sm" weight="bold">
        {draft.title}
      </Text>
      <Text type="body" size="2xs" color="secondary">
        {draft.summary}
      </Text>
      <List listStyle="disc" density="compact">
        {draft.acceptance_criteria.map((item, index) => (
          <ListItem
            key={`${item}-${index}`}
            label={
              <Text type="body" size="2xs" color="secondary">
                {item}
              </Text>
            }
          />
        ))}
      </List>
    </VStack>
  );
}

function SummaryCard({
  summary,
  busy,
  onContinue,
}: {
  summary: RequirementDraft;
  busy: boolean;
  onContinue: () => void;
}) {
  return (
    <Card aria-label="需求说明" height="100%" padding={0}>
      <VStack gap={0} align="stretch" height="100%">
        <Header title="需求说明" />
        <VStack
          gap={3}
          align="stretch"
          padding={4}
          style={{ overflowY: "auto", flex: "1 1 auto" }}
        >
          <DraftBody draft={summary} />
        </VStack>
        <HStack
          wrap="wrap"
          gap={2}
          padding={4}
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--card-border)",
          }}
        >
          <Button
            label="作为需求继续"
            variant="primary"
            isDisabled={busy}
            onClick={onContinue}
          />
        </HStack>
      </VStack>
    </Card>
  );
}

function ConfirmCard({
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
    <Card aria-label="需求确认" height="100%" padding={0}>
      <VStack gap={0} align="stretch" height="100%">
        <Header
          title="需求确认"
          subtitle={requirementStatusText(requirement.status)}
        />
        <VStack
          gap={3}
          align="stretch"
          padding={4}
          style={{ overflowY: "auto", flex: "1 1 auto" }}
        >
          <DraftBody draft={prompt.draft} />
        </VStack>
        <HStack
          wrap="wrap"
          gap={2}
          padding={4}
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--card-border)",
          }}
        >
          <Button
            label="确认并执行"
            variant="primary"
            isDisabled={busy}
            onClick={onConfirm}
          />
          <Button
            label="继续补充"
            variant="secondary"
            isDisabled={busy}
            onClick={onContinueEditing}
          />
        </HStack>
      </VStack>
    </Card>
  );
}

function AskCard({
  prompt,
  requirement,
  answers,
  busy,
  onAnswerChange,
  onSubmit,
}: {
  prompt: Extract<RequirementConversationPrompt, { type: "clarification" }>;
  requirement: Requirement;
  answers: Record<string, DraftClarificationAnswer>;
  busy: boolean;
  onAnswerChange: (
    clarification: RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  onSubmit: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const promptKey = useMemo(
    () =>
      `${prompt.round}:${prompt.questions.map((item) => item.id).join(",")}`,
    [prompt.round, prompt.questions],
  );
  const safeIndex = Math.min(
    activeIndex,
    Math.max(prompt.questions.length - 1, 0),
  );
  const question = prompt.questions[safeIndex];
  const answer = question
    ? (answers[question.id] ?? createDraftAnswer(question))
    : undefined;
  const allAnswered = prompt.questions.every((item) =>
    hasDraftAnswer(item, answers[item.id] ?? createDraftAnswer(item)),
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [promptKey]);

  if (!question || !answer) {
    return (
      <Card aria-label="澄清" height="100%" padding={4}>
        <Text type="supporting" size="2xs">
          暂无需要澄清的问题
        </Text>
      </Card>
    );
  }

  function advance() {
    if (safeIndex < prompt.questions.length - 1) {
      setActiveIndex(safeIndex + 1);
      return;
    }
    onSubmit();
  }

  return (
    <Card aria-label="澄清" height="100%" padding={0}>
      <VStack gap={0} align="stretch" height="100%">
        <Header
          title={`澄清 · 第 ${prompt.round} 轮`}
          subtitle={`${safeIndex + 1}/${prompt.questions.length}`}
        />
        <VStack
          gap={3}
          align="stretch"
          padding={4}
          style={{ overflowY: "auto", flex: "1 1 auto" }}
        >
          <HStack wrap="wrap" gap={1.5}>
            {prompt.questions.map((item, index) => (
              <Button
                key={item.id}
                label={`${index + 1}`}
                size="sm"
                variant={index === safeIndex ? "primary" : "ghost"}
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
          </HStack>
          <Text type="body" size="sm" weight="bold">
            {question.question}
          </Text>
          {question.question_type === "free_text" ? (
            <TextArea
              label="补充说明"
              isLabelHidden
              value={answer.customText}
              onChange={(value) =>
                onAnswerChange(question, {
                  ...answer,
                  customText: value,
                })
              }
              placeholder="输入你的补充说明"
              rows={4}
            />
          ) : (
            <VStack gap={2} align="stretch">
              {question.options.map((option) => {
                const selected = answer.selectedOptions.includes(option.value);
                return (
                  <Button
                    key={option.value}
                    label={option.label}
                    variant={selected ? "primary" : "secondary"}
                    style={{ width: "100%" }}
                    onClick={() => {
                      const next = toggleClarificationOption(
                        question,
                        answer,
                        option.value,
                      );
                      onAnswerChange(question, next);
                      if (
                        question.question_type === "single_choice" &&
                        safeIndex < prompt.questions.length - 1
                      ) {
                        setActiveIndex(safeIndex + 1);
                      }
                    }}
                  >
                    <Text type="label" size="2xs" weight="bold">
                      {option.label}
                    </Text>
                    {option.description ? (
                      <Text type="supporting" size="2xs">
                        {option.description}
                      </Text>
                    ) : null}
                  </Button>
                );
              })}
            </VStack>
          )}
        </VStack>
        <HStack
          wrap="wrap"
          gap={2}
          padding={4}
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--card-border)",
          }}
        >
          <Button
            label={
              safeIndex < prompt.questions.length - 1 ? "继续" : "提交澄清"
            }
            variant="primary"
            isDisabled={busy || !hasDraftAnswer(question, answer)}
            onClick={advance}
          />
          <Button
            label="全部提交"
            variant="secondary"
            isDisabled={busy || !allAnswered}
            onClick={onSubmit}
          />
        </HStack>
      </VStack>
    </Card>
  );
}
