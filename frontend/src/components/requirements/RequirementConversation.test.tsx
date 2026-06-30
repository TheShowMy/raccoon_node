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

    expect(screen.getByText("你")).toBeInTheDocument();
    expect(screen.getByText("我要新增登录")).toBeInTheDocument();
    expect(screen.getByText("Coordinator")).toBeInTheDocument();
    expect(screen.getByText("我会先澄清范围")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Coordinator 正在处理"));
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
      screen.getByPlaceholderText("可回答上方问题，也可以直接补充说明..."),
    ).not.toBeDisabled();
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

    const stopButton = screen.getByRole("button", { name: "停止分析" });
    expect(stopButton).toBeInTheDocument();
    fireEvent.click(stopButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("requests abandoning an unfinished conversation", () => {
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
        onAbandon={onAbandon}
      />,
    );

    const abandonButton = screen.getByRole("button", {
      name: "放弃当前需求",
    });
    expect(abandonButton).toBeInTheDocument();

    fireEvent.click(abandonButton);
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });
});
