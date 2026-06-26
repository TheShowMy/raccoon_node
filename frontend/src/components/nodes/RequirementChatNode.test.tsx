// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import RequirementChatNode from "./RequirementChatNode";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

function data(projectId: string, overrides: Partial<ChatData> = {}): ChatData {
  const base: ChatData = {
    kind: "requirement-chat",
    project: {
      id: projectId,
      name: projectId,
      git_url: "https://example.com/repo.git",
      local_path: "/tmp/repo",
      created_at: "2026-06-25T00:00:00Z",
      updated_at: "2026-06-25T00:00:00Z",
    },
    requirement: null,
    conversation: null,
    promptDismissed: false,
    input: "",
    busy: false,
    error: null,
    streamEvents: [],
    projectChat: null,
    projectChatInput: "",
    projectChatBusy: false,
    projectChatError: null,
    projectChatEvents: [],
    answers: {},
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onProjectChatInputChange: vi.fn(),
    onProjectChatSend: vi.fn(),
    onAnswerChange: vi.fn(),
    onSubmitClarifications: vi.fn(),
    onConfirm: vi.fn(),
    onContinueEditing: vi.fn(),
    onCancel: vi.fn(),
    onAbandon: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe("RequirementChatNode", () => {
  it("switches stacked cards and resets to requirement chat for a new project", () => {
    const view = render(<RequirementChatNode data={data("project-1")} />);
    const projectSwitch = screen.getByRole("button", {
      name: "切换到项目问答",
    });
    const requirementSwitch = screen.getByRole("button", {
      name: "切换到需求会话",
    });

    expect(requirementSwitch.closest("section")).toHaveClass("is-active");
    fireEvent.click(projectSwitch);
    expect(projectSwitch.closest("section")).toHaveClass("is-active");

    view.rerender(<RequirementChatNode data={data("project-2")} />);
    expect(requirementSwitch.closest("section")).toHaveClass("is-active");
  });

  it("renders project chat as conversation bubbles and hides raw Pi payload", () => {
    render(
      <RequirementChatNode
        data={data("project-1", {
          projectChat: {
            project_id: "project-1",
            running: true,
            error: null,
            updated_at: "2026-06-25T00:00:10Z",
            messages: [
              {
                role: "user",
                content: "入口在哪里？",
                created_at: "2026-06-25T00:00:00Z",
              },
              {
                role: "assistant",
                content: "入口在 src/main.rs。",
                created_at: "2026-06-25T00:00:05Z",
              },
            ],
          },
          projectChatEvents: [
            {
              project_id: "project-1",
              event: "pi_event",
              message: "正在生成内容。",
              pi_type: "message_update",
              payload: {
                assistantMessageEvent: {
                  type: "thinking_delta",
                  delta: "正在查看入口。",
                },
              },
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换到项目问答" }));

    expect(screen.getByText("你")).toBeInTheDocument();
    expect(screen.getByText("入口在哪里？")).toBeInTheDocument();
    expect(screen.getAllByText("Pi Agent").length).toBeGreaterThan(0);
    expect(screen.getByText("入口在 src/main.rs。")).toBeInTheDocument();
    expect(screen.getByText("正在回答")).toBeInTheDocument();
    expect(screen.getByText("正在查看入口。")).toBeInTheDocument();
    expect(screen.queryByText(/assistantMessageEvent/)).not.toBeInTheDocument();
  });

  it("renders persisted project chat trace and keeps tool output collapsed", () => {
    render(
      <RequirementChatNode
        data={data("project-1", {
          projectChat: {
            project_id: "project-1",
            running: false,
            error: null,
            updated_at: "2026-06-25T00:00:10Z",
            messages: [
              {
                role: "assistant",
                content: "入口在 src/main.rs。",
                created_at: "2026-06-25T00:00:05Z",
                metadata: {
                  type: "pi_trace",
                  version: 1,
                  trace: {
                    thinking: "检查入口文件",
                    output: "",
                    statuses: [],
                    tools: [
                      {
                        toolCallId: "tool-1",
                        toolName: "rg",
                        status: "done",
                        output: "src/main.rs",
                      },
                    ],
                  },
                },
              },
            ],
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换到项目问答" }));

    expect(screen.getByText("回答过程")).toBeInTheDocument();
    expect(screen.queryByText("检查入口文件")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("回答过程"));
    expect(screen.getByText("检查入口文件")).toBeInTheDocument();
    expect(screen.getByText("rg")).toBeInTheDocument();
    expect(screen.queryByText("src/main.rs")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("查看输出"));
    expect(screen.getByText("src/main.rs")).toBeInTheDocument();
  });

  it("hides stale live process and completion notices after completion", () => {
    render(
      <RequirementChatNode
        data={data("project-1", {
          projectChat: {
            project_id: "project-1",
            running: false,
            error: null,
            updated_at: "2026-06-25T00:00:10Z",
            messages: [
              {
                role: "user",
                content: "前端建议？",
                created_at: "2026-06-25T00:00:00Z",
              },
              {
                role: "assistant",
                content: "建议统一设计系统。",
                created_at: "2026-06-25T00:00:05Z",
                metadata: {
                  type: "pi_trace",
                  version: 1,
                  trace: {
                    thinking: "整理建议",
                    output: "",
                    statuses: [],
                    tools: [],
                  },
                },
              },
            ],
          },
          projectChatEvents: [
            {
              project_id: "project-1",
              event: "project_chat_completed",
              message: "项目问答已完成。",
            },
            {
              project_id: "project-1",
              event: "pi_event",
              message: "本轮处理完成。",
              pi_type: "turn_end",
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换到项目问答" }));

    expect(screen.getByText("前端建议？")).toBeInTheDocument();
    expect(screen.getByText("建议统一设计系统。")).toBeInTheDocument();
    expect(screen.getByText("回答过程")).toBeInTheDocument();
    expect(screen.queryByText("正在回答")).not.toBeInTheDocument();
    expect(screen.queryByText("项目问答已完成。")).not.toBeInTheDocument();
  });
});
