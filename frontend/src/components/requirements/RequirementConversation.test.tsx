// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RequirementConversationWorkbench from "./RequirementConversation";
import type {
  Requirement,
  RequirementConversation,
  RequirementConversationPrompt,
} from "../../types/api";

const now = "2026-06-22T06:00:00.000Z";

function testRequirement(): Requirement {
  return {
    id: "req-1",
    project_id: "project-1",
    title: "新增登录",
    original_message: "新增登录",
    status: "clarifying",
    messages: [],
    clarification_round: 1,
    clarifications: [],
    draft: null,
    execution_plan: null,
    pi_session_file: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
}

describe("RequirementConversationWorkbench", () => {
  it("renders prompt shelf as overlay and blocks composer", () => {
    const requirement = testRequirement();
    const prompt: RequirementConversationPrompt = {
      type: "clarification",
      round: 1,
      questions: [
        {
          id: "q1",
          question: "请选择范围",
          question_type: "single_choice",
          options: [
            {
              value: "small",
              label: "核心流程",
              description: "先做主链路",
              recommended: true,
            },
          ],
          answer: null,
        },
      ],
    };
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: requirement.status,
      running: false,
      items: [],
      prompt,
      error: null,
      updated_at: now,
    };

    const { container } = render(
      <RequirementConversationWorkbench
        conversation={conversation}
        requirement={requirement}
        projectName="alpha"
        prompt={prompt}
        promptDismissed={false}
        input="补充说明"
        busy={false}
        error={null}
        streamEvents={[]}
        answers={{}}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAnswerChange={vi.fn()}
        onSubmitClarifications={vi.fn()}
        onConfirm={vi.fn()}
        onContinueEditing={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(container.querySelector(".rq-prompt-layer")).not.toBeNull();
    expect(screen.getByText("澄清 · 第 1 轮")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("先处理上方卡片，或选择继续补充"),
    ).toBeDisabled();
  });
});
