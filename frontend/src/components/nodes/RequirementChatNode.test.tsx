// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import RequirementChatNode from "./RequirementChatNode";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

function data(overrides: Partial<ChatData> = {}): ChatData {
  return {
    kind: "requirement-chat",
    project: {
      id: "current",
      name: "repo",
      git_url: "",
      local_path: "D:\\repo",
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    },
    requirement: null,
    conversation: null,
    promptDismissed: false,
    input: "",
    busy: false,
    error: null,
    streamEvents: [],
    projectChat: {
      project_id: "current",
      messages: [],
      running: false,
      error: null,
      updated_at: "2026-07-10T00:00:00Z",
    },
    projectChatInput: "",
    projectChatBusy: false,
    projectChatError: null,
    projectChatEvents: [],
    answers: {},
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onProjectChatInputChange: vi.fn(),
    onProjectChatSend: vi.fn(),
    onProjectChatAbort: vi.fn(),
    onProjectChatGenerateRequirement: vi.fn(),
    onProjectChatReset: vi.fn(),
    onRetryRequirementSummarySync: vi.fn(),
    onOpenRequirement: vi.fn(),
    onAnswerChange: vi.fn(),
    onSubmitClarifications: vi.fn(),
    onConfirm: vi.fn(),
    onContinueEditing: vi.fn(),
    onCancel: vi.fn(),
    onAbandon: vi.fn(),
    ...overrides,
  };
}

describe("RequirementChatNode", () => {
  it("renders one ordinary chat surface without conversation tabs", () => {
    render(<RequirementChatNode data={data()} />);
    expect(screen.getByText("项目对话")).toBeInTheDocument();
    expect(screen.queryByText("需求会话")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("shows exactly two slash commands and enters requirement drafting", () => {
    const props = data({ projectChatInput: "/" });
    render(<RequirementChatNode data={props} />);
    expect(screen.getByRole("menu", { name: "聊天命令" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "需求生成" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建会话" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "需求生成" }));
    expect(screen.getByText("需求生成")).toBeInTheDocument();
    expect(props.onProjectChatInputChange).toHaveBeenCalledWith("");
    expect(props.onInputChange).toHaveBeenCalledWith("");
  });

  it("accepts a requirement command with inline text", () => {
    const props = data();
    render(<RequirementChatNode data={props} />);
    const input = screen.getByLabelText("询问项目代码、结构或实现，或输入 /");
    input.textContent = "/需求生成 增加导出功能";
    fireEvent.input(input);
    expect(props.onInputChange).toHaveBeenCalledWith("增加导出功能");
    expect(screen.getByText("需求生成")).toBeInTheDocument();
  });

  it("keeps the composer visible below a versioned confirmation card", () => {
    const requirement = {
      id: "req-1",
      project_id: "current",
      title: "导出",
      original_message: "增加导出",
      status: "draft_ready" as const,
      messages: [],
      clarification_round: 1,
      clarifications: [],
      draft: null,
      execution_plan: null,
      pi_session_file: null,
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    render(
      <RequirementChatNode
        data={data({
          requirement,
          conversation: {
            id: "req-1",
            project_id: "current",
            title: "导出",
            status: "draft_ready",
            running: false,
            items: [],
            prompt: {
              type: "confirmation",
              prompt_id: "prompt-1",
              revision: 2,
              draft: {
                title: "导出",
                summary: "增加导出功能",
                acceptance_criteria: ["可导出 CSV"],
              },
            },
            error: null,
            updated_at: "2026-07-10T00:00:00Z",
          },
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "确认并执行" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("确认前可继续补充或要求修改..."),
    ).toBeInTheDocument();
  });

  it("renders a failed main-session summary card with retry and open actions", () => {
    const props = data({
      projectChat: {
        project_id: "current",
        running: false,
        error: null,
        updated_at: "2026-07-10T00:00:00Z",
        messages: [
          {
            role: "system",
            content: "summary",
            created_at: "2026-07-10T00:00:00Z",
            requirement_context: {
              requirement_id: "req-1",
              draft: {
                title: "导出",
                summary: "增加导出功能",
                acceptance_criteria: ["可导出 CSV"],
              },
              sync_status: "failed",
              sync_error: "rpc offline",
            },
          },
        ],
      },
    });
    render(<RequirementChatNode data={props} />);
    expect(screen.getByText("rpc offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试写回" }));
    expect(props.onRetryRequirementSummarySync).toHaveBeenCalledWith("req-1");
    fireEvent.click(screen.getByRole("button", { name: "打开需求" }));
    expect(props.onOpenRequirement).toHaveBeenCalledWith("req-1");
  });
});
