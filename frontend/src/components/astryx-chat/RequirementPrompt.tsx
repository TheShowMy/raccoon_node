import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text, Heading } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import type { StartNodeData } from "../../types/api";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

function hasAnswer(
  type: "single_choice" | "multi_choice" | "free_text",
  selected: string[],
  text: string,
) {
  return type === "free_text" ? Boolean(text.trim()) : selected.length > 0;
}

export default function RequirementPrompt({ data }: { data: ChatData }) {
  const prompt = data.conversation?.prompt;
  const requirement = data.requirement;
  if (!prompt || !requirement || data.promptDismissed) return null;

  if (prompt.type === "confirmation") {
    return (
      <VStack gap={3} width="100%">
        <VStack gap={1} width="100%">
          <Heading level={3}>{prompt.draft.title}</Heading>
          <Text>{prompt.draft.summary}</Text>
        </VStack>
        <List>
          {prompt.draft.acceptance_criteria.map((criterion, index) => (
            <ListItem
              key={criterion}
              label={criterion}
              startContent={
                <Badge label={String(index + 1)} variant="neutral" />
              }
            />
          ))}
        </List>
        <Divider />
        <HStack gap={2} justify="end" wrap="wrap">
          <Button
            label="放弃"
            variant="destructive"
            isDisabled={data.busy}
            onClick={data.onAbandon}
          />
          <Button
            label="继续修改"
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
      </VStack>
    );
  }

  const valid = prompt.questions.every((question) => {
    const answer = data.answers[question.id] ?? {
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
    <VStack gap={3} width="100%">
      <Heading level={3}>需要确认的信息</Heading>
      {prompt.questions.map((question, questionIndex) => {
        const answer = data.answers[question.id] ?? {
          selectedOptions: question.answer?.selected_options ?? [],
          customText: question.answer?.custom_text ?? "",
        };
        const choose = (value: string) => {
          const selectedOptions =
            question.question_type === "single_choice"
              ? [value]
              : answer.selectedOptions.includes(value)
                ? answer.selectedOptions.filter((item) => item !== value)
                : [...answer.selectedOptions, value];
          data.onAnswerChange(question, { ...answer, selectedOptions });
        };
        return (
          <VStack key={question.id} gap={2} width="100%">
            <Text weight="bold">
              {questionIndex + 1}. {question.question}
            </Text>
            {question.question_type !== "free_text" ? (
              <List>
                {question.options.map((option) => (
                  <ListItem
                    key={option.value}
                    label={option.label}
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
                  data.onAnswerChange(question, { ...answer, customText })
                }
              />
            )}
          </VStack>
        );
      })}
      <HStack gap={2} justify="end">
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
          onClick={() => void data.onSubmitClarifications(requirement)}
        />
      </HStack>
    </VStack>
  );
}
