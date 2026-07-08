// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  Requirement,
  RequirementClarification,
  RequirementConversationPrompt,
} from "../../types/api";
import RequirementCardPanel from "./RequirementCardPanel";

const now = "2026-06-22T06:00:00.000Z";

function baseRequirement(): Requirement {
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

describe("RequirementCardPanel", () => {
  it("renders a clarification card and navigates questions", () => {
    const q1: RequirementClarification = {
      id: "q1",
      question: "问题一",
      question_type: "single_choice",
      options: [
        { value: "a", label: "A", description: "", recommended: false },
      ],
      answer: null,
    };
    const q2: RequirementClarification = {
      id: "q2",
      question: "问题二",
      question_type: "single_choice",
      options: [
        { value: "b", label: "B", description: "", recommended: false },
      ],
      answer: null,
    };
    const prompt: RequirementConversationPrompt = {
      type: "clarification",
      round: 1,
      questions: [q1, q2],
    };
    const onAnswerChange = vi.fn();

    render(
      <RequirementCardPanel
        prompt={prompt}
        requirement={baseRequirement()}
        summary={null}
        answers={{}}
        busy={false}
        onAnswerChange={onAnswerChange}
        onSubmitClarifications={vi.fn()}
        onConfirm={vi.fn()}
        onContinueEditing={vi.fn()}
        onContinueWithSummary={vi.fn()}
      />,
    );

    expect(screen.getByText("澄清 · 第 1 轮")).toBeInTheDocument();
    expect(screen.getByText("问题一")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(onAnswerChange).toHaveBeenCalledWith(q1, {
      selectedOptions: ["a"],
      customText: "",
    });
    expect(screen.getByText("问题二")).toBeInTheDocument();
  });

  it("submits all clarifications when clicking 全部提交", () => {
    const q1: RequirementClarification = {
      id: "q1",
      question: "scope",
      question_type: "single_choice",
      options: [
        {
          value: "core",
          label: "core",
          description: "main path",
          recommended: true,
        },
      ],
      answer: null,
    };
    const prompt: RequirementConversationPrompt = {
      type: "clarification",
      round: 1,
      questions: [q1],
    };
    const onSubmit = vi.fn();
    const requirement = baseRequirement();

    render(
      <RequirementCardPanel
        prompt={prompt}
        requirement={requirement}
        summary={null}
        answers={{ q1: { selectedOptions: ["core"], customText: "" } }}
        busy={false}
        onAnswerChange={vi.fn()}
        onSubmitClarifications={onSubmit}
        onConfirm={vi.fn()}
        onContinueEditing={vi.fn()}
        onContinueWithSummary={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全部提交" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(requirement);
  });

  it("renders a confirmation card with confirm and continue editing actions", () => {
    const prompt: RequirementConversationPrompt = {
      type: "confirmation",
      draft: {
        title: "新增登录",
        summary: "实现登录流程",
        acceptance_criteria: ["用户可以登录"],
      },
    };
    const onConfirm = vi.fn();
    const onContinueEditing = vi.fn();
    const requirement = {
      ...baseRequirement(),
      status: "draft_ready" as const,
    };

    render(
      <RequirementCardPanel
        prompt={prompt}
        requirement={requirement}
        summary={null}
        answers={{}}
        busy={false}
        onAnswerChange={vi.fn()}
        onSubmitClarifications={vi.fn()}
        onConfirm={onConfirm}
        onContinueEditing={onContinueEditing}
        onContinueWithSummary={vi.fn()}
      />,
    );

    expect(screen.getByText("需求确认")).toBeInTheDocument();
    expect(screen.getByText("新增登录")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认并执行" }));
    expect(onConfirm).toHaveBeenCalledWith(requirement);
    fireEvent.click(screen.getByRole("button", { name: "继续补充" }));
    expect(onContinueEditing).toHaveBeenCalledWith(requirement);
  });

  it("renders a summary card with continue action", () => {
    const onContinue = vi.fn();
    const summary = {
      title: "统一对话",
      summary: "重构项目问答",
      acceptance_criteria: ["保留澄清流程"],
    };

    render(
      <RequirementCardPanel
        prompt={null}
        requirement={null}
        summary={summary}
        answers={{}}
        busy={false}
        onAnswerChange={vi.fn()}
        onSubmitClarifications={vi.fn()}
        onConfirm={vi.fn()}
        onContinueEditing={vi.fn()}
        onContinueWithSummary={onContinue}
      />,
    );

    expect(screen.getByText("需求说明")).toBeInTheDocument();
    expect(screen.getByText("统一对话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "作为需求继续" }));
    expect(onContinue).toHaveBeenCalledWith(summary);
  });

  it("returns null when no prompt or summary is provided", () => {
    const { container } = render(
      <RequirementCardPanel
        prompt={null}
        requirement={null}
        summary={null}
        answers={{}}
        busy={false}
        onAnswerChange={vi.fn()}
        onSubmitClarifications={vi.fn()}
        onConfirm={vi.fn()}
        onContinueEditing={vi.fn()}
        onContinueWithSummary={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
