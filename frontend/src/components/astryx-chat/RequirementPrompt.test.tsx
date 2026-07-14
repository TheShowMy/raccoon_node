import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  DraftClarificationAnswer,
  Requirement,
  StartNodeData,
} from "../../types/api";
import RequirementPrompt from "./RequirementPrompt";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

function changeSpec(intent: string, result: string) {
  return {
    intent,
    acceptance_scenarios: [
      {
        id: "scenario-1",
        given: "用户已进入相关流程",
        when: "用户执行操作",
        then: result,
      },
    ],
    explicit_constraints: [],
    non_goals: [],
  };
}

function data(overrides: Partial<ChatData> = {}): ChatData {
  return {
    kind: "requirement-chat",
    project: {
      name: "demo",
      git_url: "",
      local_path: "D:\\demo",
    },
    requirement: null,
    conversation: null,
    requirementTimeline: [],
    hasOlderRequirementHistory: false,
    promptDismissed: false,
    busy: false,
    requirementOpeningId: null,
    error: null,
    streamEvents: [],
    projectChat: {
      messages: [],
      running: false,
      error: null,
      updated_at: "2026-07-10T00:00:00Z",
    },
    projectChatBusy: false,
    projectChatError: null,
    projectChatEvents: [],
    onSend: vi.fn(async () => true),
    onStartRequirement: vi.fn(async () => true),
    onProjectChatSend: vi.fn(async () => true),
    onProjectChatAbort: vi.fn(async () => {}),
    onProjectChatReset: vi.fn(async () => true),
    onOpenRequirement: vi.fn(),
    onLoadOlderRequirementHistory: vi.fn(async () => false),
    onSubmitClarifications: vi.fn(async () => true),
    onConfirm: vi.fn(async () => {}),
    onRetryAnalysis: vi.fn(async () => {}),
    onContinueEditing: vi.fn(),
    onCancel: vi.fn(),
    onAbandon: vi.fn(),
    ...overrides,
  };
}

function clarificationFixture(
  id: string,
  question: string,
  type: "single_choice" | "multi_choice" | "free_text" = "single_choice",
) {
  return {
    id,
    question,
    question_type: type,
    options: [
      {
        value: `${id}-a`,
        label: `${question} 选项 A`,
        description: "描述 A",
        recommended: false,
      },
      {
        value: `${id}-b`,
        label: `${question} 选项 B`,
        description: "描述 B",
        recommended: true,
      },
    ],
    answer: null,
  };
}

describe("RequirementPrompt", () => {
  it("renders confirmation prompt unchanged", () => {
    const requirement = {
      id: "requirement-1",
      title: "登录改造",
      origin: "standalone" as const,
      status: "draft_ready" as const,
      messages: [],
      clarification_round: 0,
      clarifications: [],
      draft: changeSpec("登录改造", "更新登录流程"),
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    const conversation = {
      id: requirement.id,
      title: requirement.title,
      status: "draft_ready" as const,
      running: false,
      items: [],
      prompt: {
        type: "confirmation" as const,
        draft: requirement.draft,
        prompt_id: "prompt-1",
        revision: 1,
      },
      error: null,
      updated_at: requirement.updated_at,
    };
    render(<RequirementPrompt data={data({ requirement, conversation })} />);
    expect(
      screen.getByRole("heading", { name: "登录改造" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认需求" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "下一步" }),
    ).not.toBeInTheDocument();
  });

  it("shows only the first clarification question initially", () => {
    const requirement = {
      id: "requirement-1",
      title: "登录改造",
      origin: "standalone" as const,
      status: "clarifying" as const,
      messages: [],
      clarification_round: 1,
      clarifications: [
        clarificationFixture("q1", "第一题"),
        clarificationFixture("q2", "第二题"),
      ],
      draft: null,
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    const conversation = {
      id: requirement.id,
      title: requirement.title,
      status: "clarifying" as const,
      running: false,
      items: [],
      prompt: {
        type: "clarification" as const,
        round: 1,
        questions: requirement.clarifications,
        prompt_id: "prompt-1",
        revision: 1,
      },
      error: null,
      updated_at: requirement.updated_at,
    };
    render(<RequirementPrompt data={data({ requirement, conversation })} />);

    expect(screen.getByText("1. 第一题")).toBeInTheDocument();
    expect(screen.queryByText("2. 第二题")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "上一步" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交答案" }),
    ).not.toBeInTheDocument();
  });

  it("advances to next step after answering and allows going back", () => {
    const requirement = {
      id: "requirement-1",
      title: "登录改造",
      origin: "standalone" as const,
      status: "clarifying" as const,
      messages: [],
      clarification_round: 1,
      clarifications: [
        clarificationFixture("q1", "第一题"),
        clarificationFixture("q2", "第二题"),
      ],
      draft: null,
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    const conversation = {
      id: requirement.id,
      title: requirement.title,
      status: "clarifying" as const,
      running: false,
      items: [],
      prompt: {
        type: "clarification" as const,
        round: 1,
        questions: requirement.clarifications,
        prompt_id: "prompt-1",
        revision: 1,
      },
      error: null,
      updated_at: requirement.updated_at,
    };
    render(<RequirementPrompt data={data({ requirement, conversation })} />);

    fireEvent.click(screen.getByText("第一题 选项 B"));
    expect(screen.getByRole("button", { name: "下一步" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("2. 第二题")).toBeInTheDocument();
    expect(screen.queryByText("1. 第一题")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交答案" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByText("1. 第一题")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一步" })).toBeEnabled();
  });

  it("submits answers after answering all questions", () => {
    const onSubmitClarifications = vi.fn<
      (
        requirement: Requirement,
        answers: Record<string, DraftClarificationAnswer>,
      ) => Promise<boolean>
    >(async () => true);
    const requirement = {
      id: "requirement-1",
      title: "登录改造",
      origin: "standalone" as const,
      status: "clarifying" as const,
      messages: [],
      clarification_round: 1,
      clarifications: [
        clarificationFixture("q1", "第一题"),
        clarificationFixture("q2", "第二题"),
      ],
      draft: null,
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    const conversation = {
      id: requirement.id,
      title: requirement.title,
      status: "clarifying" as const,
      running: false,
      items: [],
      prompt: {
        type: "clarification" as const,
        round: 1,
        questions: requirement.clarifications,
        prompt_id: "prompt-1",
        revision: 1,
      },
      error: null,
      updated_at: requirement.updated_at,
    };
    render(
      <RequirementPrompt
        data={data({
          requirement,
          conversation,
          onSubmitClarifications,
        })}
      />,
    );

    fireEvent.click(screen.getByText("第一题 选项 B"));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByText("第二题 选项 A"));
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));

    expect(onSubmitClarifications).toHaveBeenCalledTimes(1);
    const submitted = onSubmitClarifications.mock.calls[0][1];
    expect(submitted.q1.selectedOptions).toEqual(["q1-b"]);
    expect(submitted.q2.selectedOptions).toEqual(["q2-a"]);
  });

  it("supports free text question type", () => {
    const onSubmitClarifications = vi.fn<
      (
        requirement: Requirement,
        answers: Record<string, DraftClarificationAnswer>,
      ) => Promise<boolean>
    >(async () => true);
    const requirement = {
      id: "requirement-1",
      title: "登录改造",
      origin: "standalone" as const,
      status: "clarifying" as const,
      messages: [],
      clarification_round: 1,
      clarifications: [
        {
          id: "q1",
          question: "补充说明",
          question_type: "free_text" as const,
          options: [],
          answer: null,
        },
      ],
      draft: null,
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    const conversation = {
      id: requirement.id,
      title: requirement.title,
      status: "clarifying" as const,
      running: false,
      items: [],
      prompt: {
        type: "clarification" as const,
        round: 1,
        questions: requirement.clarifications,
        prompt_id: "prompt-1",
        revision: 1,
      },
      error: null,
      updated_at: requirement.updated_at,
    };
    render(
      <RequirementPrompt
        data={data({
          requirement,
          conversation,
          onSubmitClarifications,
        })}
      />,
    );

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "我的补充" },
    });
    expect(screen.getByRole("button", { name: "提交答案" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    const submitted = onSubmitClarifications.mock.calls[0][1];
    expect(submitted.q1.customText).toBe("我的补充");
  });
});
