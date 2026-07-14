import { useEffect, useRef, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { List, ListItem } from "@astryxdesign/core/List";
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  VStack,
} from "@astryxdesign/core/Layout";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text, Heading } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import type {
  DraftClarificationAnswer,
  RequirementClarification,
  StartNodeData,
} from "../../types/api";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

function hasAnswer(
  type: "single_choice" | "multi_choice" | "free_text",
  selected: string[],
  text: string,
) {
  return type === "free_text" ? Boolean(text.trim()) : selected.length > 0;
}

function getAnswer(
  answers: Record<string, DraftClarificationAnswer>,
  question: RequirementClarification,
): DraftClarificationAnswer {
  return (
    answers[question.id] ?? {
      selectedOptions: question.answer?.selected_options ?? [],
      customText: question.answer?.custom_text ?? "",
    }
  );
}

function isQuestionAnswered(
  question: RequirementClarification,
  answer: DraftClarificationAnswer,
) {
  return hasAnswer(
    question.question_type,
    answer.selectedOptions,
    answer.customText,
  );
}

function MultilineText({ children }: { children: string }) {
  return (
    <Text display="block" textWrap="wrap" wordBreak="break-word">
      {children}
    </Text>
  );
}

export default function RequirementPrompt({ data }: { data: ChatData }) {
  const prompt = data.conversation?.prompt;
  const requirement = data.requirement;
  const panelRef = useRef<HTMLDivElement>(null);
  const clarificationPrompt = prompt?.type === "clarification" ? prompt : null;
  const promptKey = clarificationPrompt
    ? `${requirement?.id ?? ""}:${clarificationPrompt.prompt_id ?? ""}:${clarificationPrompt.revision ?? 0}`
    : null;
  const [answers, setAnswers] = useState<
    Record<string, DraftClarificationAnswer>
  >({});
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    if (!clarificationPrompt) {
      setAnswers({});
      setCurrentStep(0);
      return;
    }
    setAnswers(
      Object.fromEntries(
        clarificationPrompt.questions.map((question) => [
          question.id,
          {
            selectedOptions: question.answer?.selected_options ?? [],
            customText: question.answer?.custom_text ?? "",
          },
        ]),
      ),
    );
    setCurrentStep(0);
  }, [promptKey]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const stopWheelPropagation = (event: WheelEvent) => event.stopPropagation();
    panel.addEventListener("wheel", stopWheelPropagation, { passive: true });
    return () => panel.removeEventListener("wheel", stopWheelPropagation);
  }, []);

  if (!prompt || !requirement || data.promptDismissed) return null;

  if (prompt.type === "confirmation") {
    return (
      <Card
        ref={panelRef}
        variant="default"
        width="100%"
        height="min(42vh, calc(var(--spacing-12) * 8))"
        padding={0}
        data-testid="requirement-prompt-panel"
      >
        <Layout
          padding={0}
          header={
            <LayoutHeader hasDivider padding={3}>
              <Heading level={3}>{prompt.draft.intent}</Heading>
            </LayoutHeader>
          }
          content={
            <LayoutContent
              isScrollable
              padding={3}
              label="需求确认内容"
              style={{ overscrollBehavior: "contain" }}
            >
              <VStack gap={3} width="100%">
                <List>
                  {prompt.draft.acceptance_scenarios.map((scenario, index) => (
                    <ListItem
                      key={scenario.id}
                      label={<MultilineText>{scenario.then}</MultilineText>}
                      description={`Given ${scenario.given} · When ${scenario.when}`}
                      startContent={
                        <Badge label={String(index + 1)} variant="neutral" />
                      }
                    />
                  ))}
                </List>
                {prompt.draft.explicit_constraints.length ? (
                  <List>
                    {prompt.draft.explicit_constraints.map((constraint) => (
                      <ListItem
                        key={constraint.id}
                        label={
                          <MultilineText>{constraint.statement}</MultilineText>
                        }
                        description={`用户显式约束 · ${constraint.source_message_id}`}
                      />
                    ))}
                  </List>
                ) : null}
                {prompt.draft.non_goals.length ? (
                  <List>
                    {prompt.draft.non_goals.map((nonGoal) => (
                      <ListItem
                        key={nonGoal}
                        label={<MultilineText>{nonGoal}</MultilineText>}
                        description="不在本次范围"
                      />
                    ))}
                  </List>
                ) : null}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider padding={3}>
              <HStack gap={2} justify="end" wrap="wrap">
                <Button
                  label="放弃"
                  variant="destructive"
                  isDisabled={data.busy}
                  onClick={data.onAbandon}
                />
                <Button
                  label="继续补充"
                  variant="secondary"
                  isDisabled={data.busy}
                  onClick={() => data.onContinueEditing(requirement)}
                />
                <Button
                  label="确认需求"
                  variant="primary"
                  isLoading={data.busy}
                  onClick={() => void data.onConfirm(requirement)}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Card>
    );
  }

  const questions = prompt.questions;
  const totalSteps = questions.length;
  const question = questions[currentStep];
  const answer = getAnswer(answers, question);
  const currentAnswered = isQuestionAnswered(question, answer);
  const allAnswered = questions.every((item) =>
    isQuestionAnswered(item, getAnswer(answers, item)),
  );
  const isLastStep = currentStep === totalSteps - 1;
  const progressValue =
    totalSteps > 0 ? ((currentStep + 1) / totalSteps) * 100 : 0;

  const choose = (value: string) => {
    const selectedOptions =
      question.question_type === "single_choice"
        ? [value]
        : answer.selectedOptions.includes(value)
          ? answer.selectedOptions.filter((item) => item !== value)
          : [...answer.selectedOptions, value];
    setAnswers((current) => ({
      ...current,
      [question.id]: { ...answer, selectedOptions },
    }));
  };

  return (
    <Card
      ref={panelRef}
      variant="default"
      width="100%"
      height="min(42vh, calc(var(--spacing-12) * 8))"
      padding={0}
      data-testid="requirement-prompt-panel"
    >
      <Layout
        padding={0}
        header={
          <LayoutHeader hasDivider padding={3}>
            <VStack gap={2} width="100%">
              <Heading level={3}>需要确认的信息</Heading>
              <ProgressBar
                label="澄清进度"
                value={progressValue}
                max={100}
                isLabelHidden
                hasValueLabel
                formatValueLabel={() =>
                  `问题 ${currentStep + 1} / ${totalSteps}`
                }
                variant="accent"
              />
            </VStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent
            isScrollable
            padding={3}
            label="需求澄清问题"
            style={{ overscrollBehavior: "contain" }}
          >
            <VStack key={question.id} gap={3} width="100%">
              <Text
                weight="bold"
                display="block"
                textWrap="wrap"
                wordBreak="break-word"
              >
                {currentStep + 1}. {question.question}
              </Text>
              {question.question_type !== "free_text" ? (
                <List>
                  {question.options.map((option) => (
                    <ListItem
                      key={option.value}
                      label={<MultilineText>{option.label}</MultilineText>}
                      description={option.description}
                      startContent={
                        <Badge
                          label={option.recommended ? "推荐" : "选项"}
                          variant={option.recommended ? "info" : "neutral"}
                        />
                      }
                      isSelected={answer.selectedOptions.includes(option.value)}
                      onClick={() => choose(option.value)}
                    />
                  ))}
                </List>
              ) : (
                <TextArea
                  label={question.question}
                  isLabelHidden
                  value={answer.customText}
                  rows={3}
                  onChange={(customText) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: { ...answer, customText },
                    }))
                  }
                />
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider padding={3}>
            <HStack gap={2} justify="end" wrap="wrap">
              <Button
                label="放弃"
                variant="destructive"
                isDisabled={data.busy}
                onClick={data.onAbandon}
              />
              {currentStep > 0 && (
                <Button
                  label="上一步"
                  variant="secondary"
                  isDisabled={data.busy}
                  onClick={() => setCurrentStep((step) => step - 1)}
                />
              )}
              {!isLastStep ? (
                <Button
                  label="下一步"
                  variant="primary"
                  isDisabled={!currentAnswered || data.busy}
                  onClick={() => setCurrentStep((step) => step + 1)}
                />
              ) : (
                <Button
                  label="提交答案"
                  variant="primary"
                  isDisabled={!allAnswered || data.busy}
                  isLoading={data.busy}
                  onClick={() =>
                    void data.onSubmitClarifications(requirement, answers)
                  }
                />
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Card>
  );
}
