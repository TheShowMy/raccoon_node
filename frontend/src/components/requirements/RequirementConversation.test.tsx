// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
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
        onAbandon={vi.fn()}
      />,
    );

    expect(container.querySelector(".rq-prompt-layer")).not.toBeNull();
    expect(screen.getByText("澄清 · 第 1 轮")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("先处理上方卡片，或选择继续补充"),
    ).toBeDisabled();
  });

  it("uses the combined confirmation and execution label", () => {
    const requirement = testRequirement();
    const prompt: RequirementConversationPrompt = {
      type: "confirmation",
      draft: {
        title: "新增登录",
        summary: "实现登录流程",
        acceptance_criteria: ["用户可以登录"],
      },
    };
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: "draft_ready",
      running: false,
      items: [],
      prompt,
      error: null,
      updated_at: now,
    };

    render(
      <RequirementConversationWorkbench
        conversation={conversation}
        requirement={{ ...requirement, status: "draft_ready" }}
        projectName="alpha"
        prompt={prompt}
        promptDismissed={false}
        input=""
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
        onAbandon={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "确认并执行" }),
    ).toBeInTheDocument();
  });

  it("shows a stop button while running and calls onCancel when clicked", () => {
    const requirement = testRequirement();
    requirement.status = "analyzing";
    const onCancel = vi.fn();
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: "analyzing",
      running: true,
      items: [],
      prompt: null,
      error: null,
      updated_at: now,
    };

    render(
      <RequirementConversationWorkbench
        conversation={conversation}
        requirement={requirement}
        projectName="alpha"
        prompt={null}
        promptDismissed={false}
        input=""
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
        onCancel={onCancel}
        onAbandon={vi.fn()}
      />,
    );

    const stopButton = screen.getByRole("button", { name: "停止分析" });
    expect(stopButton).toBeInTheDocument();
    fireEvent.click(stopButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows an abandon button for unfinished conversations and confirms before calling onAbandon", () => {
    const requirement = testRequirement();
    requirement.status = "clarifying";
    const onAbandon = vi.fn();
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: "clarifying",
      running: false,
      items: [],
      prompt: null,
      error: null,
      updated_at: now,
    };

    render(
      <RequirementConversationWorkbench
        conversation={conversation}
        requirement={requirement}
        projectName="alpha"
        prompt={null}
        promptDismissed={false}
        input=""
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
        onAbandon={onAbandon}
      />,
    );

    const abandonButton = screen.getByRole("button", {
      name: "放弃当前需求",
    });
    expect(abandonButton).toBeInTheDocument();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(abandonButton);
    expect(onAbandon).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(abandonButton);
    expect(onAbandon).toHaveBeenCalledTimes(1);

    confirmSpy.mockRestore();
  });
});
