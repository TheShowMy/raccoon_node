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
import { Text, Heading } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import type { DraftClarificationAnswer, StartNodeData } from "../../types/api";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

function hasAnswer(
  type: "single_choice" | "multi_choice" | "free_text",
  selected: string[],
  text: string,
) {
  return type === "free_text" ? Boolean(text.trim()) : selected.length > 0;
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

  useEffect(() => {
    if (!clarificationPrompt) {
      setAnswers({});
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
              <Heading level={3}>{prompt.draft.title}</Heading>
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
                <MultilineText>{prompt.draft.summary}</MultilineText>
                <List>
                  {prompt.draft.acceptance_criteria.map((criterion, index) => (
                    <ListItem
                      key={criterion}
                      label={<MultilineText>{criterion}</MultilineText>}
                      startContent={
                        <Badge label={String(index + 1)} variant="neutral" />
                      }
                    />
                  ))}
                </List>
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

  const valid = prompt.questions.every((question) => {
    const answer = answers[question.id] ?? {
      selectedOptions: question.answer?.selected_options ?? [],
      customText: question.answer?.custom_text ?? "",
    };
    return hasAnswer(
      question.question_type,
      answer.selectedOptions,
      answer.customText,
    );
  });

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
            <Heading level={3}>需要确认的信息</Heading>
          </LayoutHeader>
        }
        content={
          <LayoutContent
            isScrollable
            padding={3}
            label="需求澄清问题"
            style={{ overscrollBehavior: "contain" }}
          >
            <VStack gap={3} width="100%">
              {prompt.questions.map((question, questionIndex) => {
                const answer = answers[question.id] ?? {
                  selectedOptions: question.answer?.selected_options ?? [],
                  customText: question.answer?.custom_text ?? "",
                };
                const choose = (value: string) => {
                  const selectedOptions =
                    question.question_type === "single_choice"
                      ? [value]
                      : answer.selectedOptions.includes(value)
                        ? answer.selectedOptions.filter(
                            (item) => item !== value,
                          )
                        : [...answer.selectedOptions, value];
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: { ...answer, selectedOptions },
                  }));
                };
                return (
                  <VStack key={question.id} gap={2} width="100%">
                    <Text
                      weight="bold"
                      display="block"
                      textWrap="wrap"
                      wordBreak="break-word"
                    >
                      {questionIndex + 1}. {question.question}
                    </Text>
                    {question.question_type !== "free_text" ? (
                      <List>
                        {question.options.map((option) => (
                          <ListItem
                            key={option.value}
                            label={
                              <MultilineText>{option.label}</MultilineText>
                            }
                            description={option.description}
                            startContent={
                              <Badge
                                label={option.recommended ? "推荐" : "选项"}
                                variant={
                                  option.recommended ? "info" : "neutral"
                                }
                              />
                            }
                            isSelected={answer.selectedOptions.includes(
                              option.value,
                            )}
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
                );
              })}
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
                label="提交答案"
                variant="primary"
                isDisabled={!valid}
                isLoading={data.busy}
                onClick={() =>
                  void data.onSubmitClarifications(requirement, answers)
                }
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Card>
  );
}
