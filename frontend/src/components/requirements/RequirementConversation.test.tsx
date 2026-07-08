// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RequirementConversationWorkbench from "./RequirementConversation";
import type {
  Requirement,
  RequirementClarification,
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
  it("renders conversation messages and process cards with shared UI", () => {
    const requirement = testRequirement();
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: requirement.status,
      running: false,
      prompt: null,
      error: null,
      updated_at: now,
      items: [
        {
          kind: "user",
          id: "user-1",
          text: "我要新增登录",
          created_at: now,
        },
        {
          kind: "assistant",
          id: "assistant-1",
          text: "我会先澄清范围",
          created_at: now,
        },
        {
          kind: "process",
          id: "process-1",
          title: "Coordinator 正在处理",
          status: "done",
          created_at: now,
          metadata: {
            type: "pi_trace",
            version: 1,
            trace: {
              thinking: "分析登录边界",
              output: "",
              tools: [],
              statuses: [],
            },
          },
        },
      ],
    };

    render(
      <RequirementConversationWorkbench
        conversation={conversation}
        requirement={requirement}
        projectName="alpha"
        projectId="project-1"
        prompt={null}
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

    expect(screen.getAllByText("你").length).toBeGreaterThan(0);
    expect(screen.getByText("我要新增登录")).toBeInTheDocument();
    expect(screen.getAllByText("Coordinator").length).toBeGreaterThan(0);
    expect(screen.getByText("我会先澄清范围")).toBeInTheDocument();
    const processCard = screen
      .getByText("Thinking")
      .closest('section[aria-label="过程"]');
    expect(processCard).not.toBeNull();
    expect(screen.queryByText("分析登录边界")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Thinking"));
    expect(screen.getByText("分析登录边界")).toBeInTheDocument();
  });

  it("renders prompt shelf as overlay and keeps composer available", () => {
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
        projectId="project-1"
        prompt={prompt}
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
      screen.getByLabelText("可回答上方问题，也可以直接补充说明..."),
    ).not.toBeDisabled();
  });

  it("hides the retry action while a failed requirement still has a prompt", () => {
    const requirement = testRequirement();
    requirement.status = "failed";
    const prompt: RequirementConversationPrompt = {
      type: "clarification",
      round: 1,
      questions: [
        {
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
        },
      ],
    };
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: "failed",
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
        projectId="project-1"
        prompt={prompt}
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

    expect(container.querySelector(".rq-prompt-layer")).not.toBeNull();
    expect(container.querySelector(".requirement-draft__confirm")).toBeNull();
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
        projectId="project-1"
        prompt={prompt}
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
        projectId="project-1"
        prompt={null}
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

    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).toBeInTheDocument();
    expect(screen.getByLabelText("正在思考")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Thinking" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("等待 Pi Agent 事件...")).not.toBeInTheDocument();
    expect(screen.queryByText("正在处理...")).not.toBeInTheDocument();
    fireEvent.click(stopButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("submits clarifications after answering all questions and clicking 全部提交", () => {
    const requirement = testRequirement();
    requirement.status = "clarifying";
    requirement.clarifications = [
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
    ];
    const prompt: RequirementConversationPrompt = {
      type: "clarification",
      round: 1,
      questions: requirement.clarifications,
    };
    const onSubmitClarifications = vi.fn();
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: "clarifying",
      running: false,
      items: [],
      prompt,
      error: null,
      updated_at: now,
    };

    render(
      <RequirementConversationWorkbench
        conversation={conversation}
        requirement={requirement}
        projectName="alpha"
        projectId="project-1"
        prompt={prompt}
        input=""
        busy={false}
        error={null}
        streamEvents={[]}
        answers={{
          q1: { selectedOptions: ["small"], customText: "" },
        }}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAnswerChange={vi.fn()}
        onSubmitClarifications={onSubmitClarifications}
        onConfirm={vi.fn()}
        onContinueEditing={vi.fn()}
        onCancel={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全部提交" }));
    expect(onSubmitClarifications).toHaveBeenCalledTimes(1);
    expect(onSubmitClarifications).toHaveBeenCalledWith(requirement);
  });

  it("submits clarifications when clicking the primary 提交澄清 button", () => {
    const requirement = testRequirement();
    requirement.status = "clarifying";
    const q1: RequirementClarification = {
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
    };
    const prompt: RequirementConversationPrompt = {
      type: "clarification",
      round: 1,
      questions: [q1],
    };
    const onSubmitClarifications = vi.fn();
    const onAnswerChange = vi.fn();
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: "clarifying",
      running: false,
      items: [],
      prompt,
      error: null,
      updated_at: now,
    };

    render(
      <RequirementConversationWorkbench
        conversation={conversation}
        requirement={requirement}
        projectName="alpha"
        projectId="project-1"
        prompt={prompt}
        input=""
        busy={false}
        error={null}
        streamEvents={[]}
        answers={{ q1: { selectedOptions: ["small"], customText: "" } }}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAnswerChange={onAnswerChange}
        onSubmitClarifications={onSubmitClarifications}
        onConfirm={vi.fn()}
        onContinueEditing={vi.fn()}
        onCancel={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "提交澄清" }));
    expect(onSubmitClarifications).toHaveBeenCalledTimes(1);
    expect(onSubmitClarifications).toHaveBeenCalledWith(requirement);
  });

  it("submits clarifications after advancing to the last question", () => {
    const requirement = testRequirement();
    requirement.status = "clarifying";
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
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: "clarifying",
      running: false,
      items: [],
      prompt,
      error: null,
      updated_at: now,
    };

    render(
      <RequirementConversationWorkbench
        conversation={conversation}
        requirement={requirement}
        projectName="alpha"
        projectId="project-1"
        prompt={prompt}
        input=""
        busy={false}
        error={null}
        streamEvents={[]}
        answers={{}}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAnswerChange={onAnswerChange}
        onSubmitClarifications={vi.fn()}
        onConfirm={vi.fn()}
        onContinueEditing={vi.fn()}
        onCancel={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(onAnswerChange).toHaveBeenCalledWith(q1, {
      selectedOptions: ["a"],
      customText: "",
    });
    expect(screen.getByText("问题二")).toBeInTheDocument();
  });

  it("resets active clarification question when prompt changes", () => {
    const requirement = testRequirement();
    requirement.status = "clarifying";
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
    const conversation: RequirementConversation = {
      id: requirement.id,
      project_id: requirement.project_id,
      title: requirement.title,
      status: "clarifying",
      running: false,
      items: [],
      prompt,
      error: null,
      updated_at: now,
    };

    const { rerender } = render(
      <RequirementConversationWorkbench
        conversation={conversation}
        requirement={requirement}
        projectName="alpha"
        projectId="project-1"
        prompt={prompt}
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

    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(screen.getByText("问题二")).toBeInTheDocument();

    const nextPrompt: RequirementConversationPrompt = {
      type: "clarification",
      round: 2,
      questions: [q2],
    };
    rerender(
      <RequirementConversationWorkbench
        conversation={{ ...conversation, prompt: nextPrompt }}
        requirement={requirement}
        projectName="alpha"
        projectId="project-1"
        prompt={nextPrompt}
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

    expect(screen.getByText("问题二")).toBeInTheDocument();
    expect(screen.queryByText("问题一")).not.toBeInTheDocument();
  });
});
