// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import RequirementChatNode from "./RequirementChatNode";

function setCursorAtEnd(element: HTMLElement) {
  element.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const textNode = element.firstChild;
  if (textNode?.nodeType === Node.TEXT_NODE) {
    range.setStart(textNode, textNode.textContent?.length ?? 0);
  } else {
    range.selectNodeContents(element);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

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
    onProjectChatAbort: vi.fn(),
    onProjectChatGenerateRequirement: vi.fn(),
    onProjectChatReset: vi.fn(),
    onAnswerChange: vi.fn(),
    onSubmitClarifications: vi.fn(),
    onConfirm: vi.fn(),
    onContinueEditing: vi.fn(),
    onCancel: vi.fn(),
    onAbandon: vi.fn(),
  };
  return { ...base, ...overrides };
}

function expectSelectedTab(tab: HTMLElement) {
  expect(tab).toHaveAttribute("aria-current", "page");
  expect(tab).toHaveAttribute("data-selected", "selected");
}

function expectUnselectedTab(tab: HTMLElement) {
  expect(tab).not.toHaveAttribute("aria-current", "page");
  expect(tab).not.toHaveAttribute("data-selected", "selected");
}

describe("RequirementChatNode", () => {
  it("switches tabs and resets to requirement chat for a new project", () => {
    const view = render(<RequirementChatNode data={data("project-1")} />);
    const projectSwitch = screen.getByRole("button", {
      name: "项目问答",
    });
    const requirementSwitch = screen.getByRole("button", {
      name: "需求会话",
    });

    expectSelectedTab(requirementSwitch);
    fireEvent.click(projectSwitch);
    expectSelectedTab(projectSwitch);

    view.rerender(<RequirementChatNode data={data("project-2")} />);
    expectSelectedTab(requirementSwitch);
  });

  it("hides a dismissed confirmation prompt", () => {
    const activeRequirement = {
      id: "requirement-1",
      project_id: "project-1",
      title: "需求",
      original_message: "需求",
      status: "draft_ready" as const,
      messages: [],
      clarification_round: 0,
      clarifications: [],
      draft: null,
      execution_plan: null,
      pi_session_file: null,
      error: null,
      created_at: "2026-06-25T00:00:00Z",
      updated_at: "2026-06-25T00:00:00Z",
    };
    const activeConversation = {
      id: activeRequirement.id,
      project_id: activeRequirement.project_id,
      title: activeRequirement.title,
      status: activeRequirement.status,
      running: false,
      items: [],
      prompt: {
        type: "confirmation" as const,
        draft: {
          title: "需求草案",
          summary: "需求摘要",
          acceptance_criteria: ["通过验收"],
        },
      },
      error: null,
      updated_at: "2026-06-25T00:00:00Z",
    };
    const view = render(
      <RequirementChatNode
        data={data("project-1", {
          requirement: activeRequirement,
          conversation: activeConversation,
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "继续补充" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "需求卡片" }),
    ).toBeInTheDocument();

    view.rerender(
      <RequirementChatNode
        data={data("project-1", {
          requirement: activeRequirement,
          conversation: activeConversation,
          promptDismissed: true,
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "继续补充" }),
    ).not.toBeInTheDocument();
  });

  it("uses explicit accessible tabs without hijacking keyboard Tab", () => {
    render(<RequirementChatNode data={data("project-1")} />);
    const stack = screen.getByLabelText("需求会话与项目问答");
    const projectSwitch = screen.getByRole("button", {
      name: "项目问答",
    });
    const input = screen.getByLabelText("继续描述你的需求...");

    fireEvent.keyDown(stack, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab" });
    expectUnselectedTab(projectSwitch);
    fireEvent.click(projectSwitch);
    expectSelectedTab(projectSwitch);
  });

  it("uses the styled confirmation dialog for abandoning requirements", () => {
    const requirement = {
      id: "requirement-1",
      project_id: "project-1",
      title: "需求",
      original_message: "需求",
      status: "clarifying" as const,
      messages: [],
      clarification_round: 0,
      clarifications: [],
      draft: null,
      execution_plan: null,
      pi_session_file: null,
      error: null,
      queued_at: null,
      created_at: "2026-06-25T00:00:00Z",
      updated_at: "2026-06-25T00:00:00Z",
    };
    const onAbandon = vi.fn();
    render(
      <RequirementChatNode
        data={data("project-1", { requirement, onAbandon })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "放弃当前需求" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("放弃当前需求？");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onAbandon).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "放弃当前需求" }));
    fireEvent.click(screen.getByRole("button", { name: "确认放弃" }));
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("confirms closing project chat and delegates the reset", () => {
    const onProjectChatReset = vi.fn().mockResolvedValue(undefined);
    render(
      <RequirementChatNode data={data("project-1", { onProjectChatReset })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "项目问答" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭项目问答会话" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("关闭项目问答？");
    fireEvent.click(screen.getByRole("button", { name: "确认关闭" }));
    expect(onProjectChatReset).toHaveBeenCalledTimes(1);
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
              type: "agent.event",
              payload: {
                project_id: "project-1",
                pi_type: "message_update",
                event: {
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "thinking_delta",
                    delta: "正在查看入口。",
                  },
                },
              },
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "项目问答" }));

    expect(screen.getAllByText("你").length).toBeGreaterThan(0);
    expect(screen.getByText("入口在哪里？")).toBeInTheDocument();
    expect(screen.getAllByText("Pi Agent").length).toBeGreaterThan(0);
    expect(screen.getByText("入口在 src/main.rs。")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("等待 Pi Agent 事件...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Thinking"));
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

    fireEvent.click(screen.getByRole("button", { name: "项目问答" }));

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getAllByText("rg").length).toBeGreaterThan(0);
    expect(screen.queryByText("src/main.rs")).not.toBeInTheDocument();
    expect(screen.queryByText("检查入口文件")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Thinking"));
    expect(screen.getByText("检查入口文件")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /rg/ }).at(-1)!);
    expect(screen.getByText("src/main.rs")).toBeInTheDocument();

    expect(
      screen.getByText("Thinking").closest(".astryx-chat-message"),
    ).toBeNull();
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
          projectChatEvents: [],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "项目问答" }));

    expect(screen.getByText("前端建议？")).toBeInTheDocument();
    expect(screen.getByText("建议统一设计系统。")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("正在回答")).not.toBeInTheDocument();
    expect(screen.queryByText("项目问答已完成。")).not.toBeInTheDocument();
  });

  it("streams answer text while keeping process card above it", () => {
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
            ],
          },
          projectChatEvents: [
            {
              type: "agent.event",
              payload: {
                project_id: "project-1",
                pi_type: "message_update",
                event: {
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "thinking_delta",
                    delta: "正在查看入口。",
                  },
                },
              },
            },
            {
              type: "agent.event",
              payload: {
                project_id: "project-1",
                pi_type: "message_update",
                event: {
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "text_delta",
                    delta: "入口在",
                  },
                },
              },
            },
            {
              type: "agent.event",
              payload: {
                project_id: "project-1",
                pi_type: "message_update",
                event: {
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "text_delta",
                    delta: " src/main.rs",
                  },
                },
              },
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "项目问答" }));

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("等待 Pi Agent 事件...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Thinking"));
    expect(screen.getByText("正在查看入口。")).toBeInTheDocument();
    expect(screen.getByText("入口在 src/main.rs")).toBeInTheDocument();

    const card = screen
      .getByText("Thinking")
      .closest('section[aria-label="过程"]') as HTMLElement;
    expect(card.closest(".astryx-chat-message")).toBeNull();
    expect(
      card.compareDocumentPosition(screen.getByText("入口在 src/main.rs")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows a thinking indicator before Pi events arrive", () => {
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
            ],
          },
          projectChatEvents: [],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "项目问答" }));

    expect(screen.getByLabelText("正在思考")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Thinking" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("等待 Pi Agent 事件...")).not.toBeInTheDocument();
    expect(screen.queryByText("正在处理...")).not.toBeInTheDocument();
  });

  it("runs the slash command without sending a chat message", async () => {
    const onProjectChatGenerateRequirement = vi.fn();
    const onProjectChatSend = vi.fn();
    render(
      <RequirementChatNode
        data={data("project-1", {
          projectChatInput: "/生成",
          onProjectChatGenerateRequirement,
          onProjectChatSend,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "项目问答" }));
    const input = screen.getByLabelText("询问项目代码、结构或实现...");
    setCursorAtEnd(input);
    fireEvent.input(input);
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "/生成需求说明" }),
      ).toBeInTheDocument(),
    );
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onProjectChatGenerateRequirement).toHaveBeenCalledTimes(1);
    expect(onProjectChatSend).not.toHaveBeenCalled();
  });

  it("prefills a confirmed summary without sending or moving attachments", () => {
    const onInputChange = vi.fn();
    const onSend = vi.fn();
    const onReferencesChange = vi.fn();
    render(
      <RequirementChatNode
        data={data("project-1", {
          projectChat: {
            project_id: "project-1",
            messages: [],
            running: false,
            error: null,
            updated_at: "2026-06-25T00:00:00Z",
            requirement_summary: {
              title: "统一对话",
              summary: "重构项目问答。",
              acceptance_criteria: ["保留澄清流程"],
            },
          },
          onInputChange,
          onSend,
          onReferencesChange,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "项目问答" }));
    fireEvent.click(screen.getByRole("button", { name: "作为需求继续" }));

    expectSelectedTab(screen.getByRole("button", { name: "需求会话" }));
    expect(onInputChange).toHaveBeenCalledWith(
      "# 统一对话\n\n重构项目问答。\n\n## 验收标准\n\n- 保留澄清流程",
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(onReferencesChange).not.toHaveBeenCalled();
  });

  it("keeps tool updates paired by the nested Pi event id", () => {
    render(
      <RequirementChatNode
        data={data("project-1", {
          projectChat: {
            project_id: "project-1",
            messages: [],
            running: true,
            error: null,
            updated_at: "2026-06-25T00:00:00Z",
          },
          projectChatEvents: [
            {
              type: "agent.event",
              payload: {
                project_id: "project-1",
                pi_type: "tool_execution_start",
                event: {
                  type: "tool_execution_start",
                  toolCallId: "tool-1",
                  toolName: "read",
                  input: { path: "src/main.rs" },
                },
              },
            },
            {
              type: "agent.event",
              payload: {
                project_id: "project-1",
                pi_type: "tool_execution_end",
                event: {
                  type: "tool_execution_end",
                  toolCallId: "tool-1",
                  toolName: "read",
                  result: { content: [{ text: "src/main.rs\nline 2" }] },
                },
              },
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "项目问答" }));

    expect(screen.getAllByText("read")).toHaveLength(1);
    expect(screen.getByText("src/main.rs")).toBeInTheDocument();
    expect(screen.queryByText(/line 2/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("read"));
    expect(screen.getByText(/line 2/)).toBeInTheDocument();
  });
});
