import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import AstryxChatSurface from "./AstryxChatSurface";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;
type TimelineBranch = ChatData["requirementTimeline"][number];

function branch(
  requirement: TimelineBranch["requirement"],
  conversation: TimelineBranch["conversation"],
  overrides: Partial<TimelineBranch> = {},
): TimelineBranch {
  const requirementId =
    requirement?.id ?? conversation?.id ?? "requirement-opening";
  return {
    requirementId,
    requirement,
    conversation,
    loading: false,
    error: null,
    createdAt:
      requirement?.created_at ??
      conversation?.updated_at ??
      "2026-07-10T00:00:00Z",
    opening: false,
    ...overrides,
  };
}

function requirementFixture(id: string, createdAt: string) {
  return {
    id,
    project_id: "current",
    title: `需求 ${id}`,
    original_message: `创建 ${id}`,
    origin: "standalone" as const,
    status: "completed" as const,
    messages: [],
    clarification_round: 0,
    clarifications: [],
    draft: null,
    execution_plan: null,
    error: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function data(overrides: Partial<ChatData> = {}): ChatData {
  return {
    kind: "requirement-chat",
    project: {
      id: "current",
      name: "demo",
      git_url: "",
      local_path: "D:\\demo",
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
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
      project_id: "current",
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

describe("AstryxChatSurface", () => {
  let intersectionCallback: IntersectionObserverCallback | null = null;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders long history in batches of 80", async () => {
    const requirement = requirementFixture(
      "requirement-history",
      "2026-07-10T00:00:00Z",
    );
    const conversation = {
      id: requirement.id,
      project_id: "current",
      title: requirement.title,
      status: "completed" as const,
      running: false,
      items: Array.from({ length: 267 }, (_, index) => ({
        kind: "assistant" as const,
        id: `history-${index}`,
        text: `history-${index}`,
        created_at: `2026-07-10T00:${String(index % 60).padStart(2, "0")}:00Z`,
      })),
      prompt: null,
      error: null,
      updated_at: requirement.updated_at,
    };
    render(
      <AstryxChatSurface
        data={data({
          requirementTimeline: [branch(requirement, conversation)],
        })}
      />,
    );

    expect(screen.getAllByText(/^history-\d+$/)).toHaveLength(80);
    expect(screen.queryByText("history-186")).not.toBeInTheDocument();
    expect(screen.getByText("history-187")).toBeInTheDocument();

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getAllByText(/^history-\d+$/)).toHaveLength(160),
    );
    expect(screen.getByText("history-107")).toBeInTheDocument();
    expect(screen.queryByText("history-106")).not.toBeInTheDocument();
  });

  it("keeps a local draft after failure and clears it only after success", async () => {
    const onProjectChatSend = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(<AstryxChatSurface data={data({ onProjectChatSend })} />);
    const input = screen.getByRole("combobox", { name: "项目聊天输入" });

    fireEvent.input(input, { target: { textContent: "保留失败的输入" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onProjectChatSend).toHaveBeenCalledTimes(1));
    const retainedInput = screen.getByRole("combobox", {
      name: "项目聊天输入",
    });
    expect(retainedInput.textContent).toBe("保留失败的输入");

    fireEvent.keyDown(retainedInput, { key: "Enter" });
    await waitFor(() => expect(onProjectChatSend).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "项目聊天输入" }).textContent,
      ).toBe(""),
    );
  });

  it("renders the Astryx AI chat frame and project composer", () => {
    render(<AstryxChatSurface data={data()} />);
    expect(
      screen.getByRole("heading", { name: "项目对话" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "项目聊天输入" }),
    ).toBeInTheDocument();
    expect(screen.getByText("询问当前项目")).toBeInTheDocument();
    const content = screen.getByTestId("astryx-chat-content");
    const stack = screen.getByTestId("astryx-chat-stack");
    const chatLayout = screen.getByTestId("astryx-chat-layout");
    expect(stack).toHaveStyle({
      width: "100%",
      height: "100%",
      minHeight: "0px",
    });
    expect(chatLayout.parentElement).toBe(stack);
    expect(stack.parentElement).toBe(content);
    expect(content).not.toHaveClass("xysyzu8");
  });

  it("keeps project messages and restored requirement branches in one ordered message list", () => {
    const firstRequirement = requirementFixture(
      "requirement-1",
      "2026-07-10T00:01:00Z",
    );
    const secondRequirement = requirementFixture(
      "requirement-2",
      "2026-07-10T00:03:00Z",
    );
    const firstConversation = {
      id: firstRequirement.id,
      project_id: "current",
      title: firstRequirement.title,
      status: "completed" as const,
      running: false,
      items: [
        {
          kind: "assistant" as const,
          id: "requirement-message-1",
          text: "第一段需求记录",
          created_at: "2026-07-10T00:01:30Z",
        },
      ],
      prompt: null,
      error: null,
      updated_at: "2026-07-10T00:02:00Z",
    };
    const secondConversation = {
      ...firstConversation,
      id: secondRequirement.id,
      title: secondRequirement.title,
      items: [
        {
          kind: "assistant" as const,
          id: "requirement-message-2",
          text: "第二段需求记录",
          created_at: "2026-07-10T00:03:30Z",
        },
      ],
      updated_at: "2026-07-10T00:04:00Z",
    };
    render(
      <AstryxChatSurface
        data={data({
          projectChat: {
            project_id: "current",
            messages: [
              {
                role: "user",
                content: "需求前的项目消息",
                created_at: "2026-07-10T00:00:00Z",
              },
              {
                role: "assistant",
                content: "两个需求之间的项目消息",
                created_at: "2026-07-10T00:02:30Z",
              },
            ],
            running: false,
            error: null,
            updated_at: "2026-07-10T00:04:00Z",
          },
          requirementTimeline: [
            branch(firstRequirement, firstConversation),
            branch(secondRequirement, secondConversation),
          ],
        })}
      />,
    );

    expect(screen.getAllByTestId("astryx-unified-message-list")).toHaveLength(
      1,
    );
    expect(screen.getAllByText("需求分支")).toHaveLength(2);
    const projectBefore = screen.getByText("需求前的项目消息");
    const firstBranch = screen.getByText("第一段需求记录");
    const projectMiddle = screen.getByText("两个需求之间的项目消息");
    const secondBranch = screen.getByText("第二段需求记录");
    expect(projectBefore.compareDocumentPosition(firstBranch)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(firstBranch.compareDocumentPosition(projectMiddle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(projectMiddle.compareDocumentPosition(secondBranch)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      screen.getByRole("heading", { name: "项目对话" }),
    ).toBeInTheDocument();
  });

  it("renders a requirement confirmation in the composer drawer", () => {
    const onConfirm = vi.fn(async () => {});
    const requirement = {
      id: "requirement-1",
      project_id: "current",
      title: "登录改造",
      original_message: "改造登录",
      origin: "standalone" as const,
      status: "draft_ready" as const,
      messages: [],
      clarification_round: 0,
      clarifications: [],
      draft: {
        title: "登录改造",
        summary: "更新登录流程",
        acceptance_criteria: ["登录测试通过"],
      },
      execution_plan: null,
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    const conversation = {
      id: requirement.id,
      project_id: "current",
      title: requirement.title,
      status: "draft_ready" as const,
      running: false,
      items: [],
      prompt: {
        type: "confirmation" as const,
        draft: requirement.draft,
        prompt_id: "prompt-1",
        revision: 2,
      },
      error: null,
      updated_at: "2026-07-10T00:00:00Z",
    };
    render(
      <AstryxChatSurface
        data={data({
          requirement,
          conversation,
          requirementTimeline: [branch(requirement, conversation)],
          onConfirm,
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "项目对话" }),
    ).toBeInTheDocument();
    expect(screen.getByText("需求分支")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-prompt-panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放弃" })).toBeVisible();
    expect(screen.getByRole("button", { name: "继续补充" })).toBeVisible();
    expect(screen.getByText("更新登录流程")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认需求" }));
    expect(onConfirm).toHaveBeenCalledWith(requirement);
  });

  it("keeps the prompt expanded and focuses the Astryx input after continue", async () => {
    const requirement = {
      ...requirementFixture("requirement-focus", "2026-07-10T00:00:00Z"),
      status: "draft_ready" as const,
      draft: {
        title: "可继续补充的需求",
        summary: "确认前仍可补充",
        acceptance_criteria: ["补充内容被保留"],
      },
    };
    const conversation = {
      id: requirement.id,
      project_id: "current",
      title: requirement.title,
      status: "draft_ready" as const,
      running: false,
      items: [],
      prompt: {
        type: "confirmation" as const,
        draft: requirement.draft,
        prompt_id: "prompt-focus",
        revision: 1,
      },
      error: null,
      updated_at: requirement.updated_at,
    };
    const onContinueEditing = vi.fn();
    const view = render(
      <AstryxChatSurface
        data={data({
          requirement,
          conversation,
          requirementTimeline: [branch(requirement, conversation)],
          onContinueEditing,
        })}
      />,
    );
    const panel = screen.getByTestId("requirement-prompt-panel");
    expect(panel).toHaveClass("astryx-card");
    expect(panel.closest(".astryx-chat-composer-drawer")).toBeNull();
    expect(panel.querySelectorAll("button")).toHaveLength(3);
    expect(panel.querySelector(".astryx-layout-content")).toBeInTheDocument();
    const footer = panel.querySelector(".astryx-layout-footer");
    expect(footer).toBeInTheDocument();
    expect(footer?.querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "继续补充" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "确认需求" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "需求输入" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
    const scrollableContent = panel.querySelector(
      ".astryx-layout-content",
    ) as HTMLElement;
    expect(scrollableContent).toHaveStyle({ overscrollBehavior: "contain" });
    const outerWheel = vi.fn();
    screen
      .getByTestId("astryx-chat-layout")
      .addEventListener("wheel", outerWheel);
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });
    scrollableContent.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(outerWheel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "继续补充" }));
    expect(onContinueEditing).toHaveBeenCalledWith(requirement);
    view.rerender(
      <AstryxChatSurface
        data={data({
          requirement,
          conversation,
          requirementTimeline: [branch(requirement, conversation)],
          promptDismissed: true,
          onContinueEditing,
        })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "需求输入" })).toHaveFocus(),
    );
  });

  it("starts a requirement from the project composer without switching early", async () => {
    const onStartRequirement = vi.fn(async () => true);
    render(<AstryxChatSurface data={data({ onStartRequirement })} />);
    const input = screen.getByRole("combobox", { name: "项目聊天输入" });

    fireEvent.input(input, {
      target: { textContent: "/需求生成 重写登录流程" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onStartRequirement).toHaveBeenCalledWith("重写登录流程", {
        references: [],
        images: [],
      }),
    );
    expect(
      screen.getByRole("heading", { name: "项目对话" }),
    ).toBeInTheDocument();
  });

  it("starts a requirement using project chat context when no description is given", async () => {
    const onStartRequirement = vi.fn(async () => true);
    render(
      <AstryxChatSurface
        data={data({
          projectChat: {
            project_id: "current",
            messages: [
              {
                role: "user",
                content: "讨论登录改造",
                created_at: "2026-07-10T00:00:00Z",
              },
            ],
            running: false,
            error: null,
            updated_at: "2026-07-10T00:00:00Z",
          },
          onStartRequirement,
        })}
      />,
    );
    const input = screen.getByRole("combobox", { name: "项目聊天输入" });
    fireEvent.input(input, { target: { textContent: "/需求生成" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onStartRequirement).toHaveBeenCalledWith("", {
        references: [],
        images: [],
      }),
    );
    expect(
      screen.getByRole("heading", { name: "项目对话" }),
    ).toBeInTheDocument();
  });

  it("starts a standalone requirement when no context is available", async () => {
    const onStartRequirement = vi.fn(async () => true);
    render(<AstryxChatSurface data={data({ onStartRequirement })} />);
    const input = screen.getByRole("combobox", { name: "项目聊天输入" });
    fireEvent.input(input, { target: { textContent: "/需求生成" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onStartRequirement).toHaveBeenCalledWith("", {
        references: [],
        images: [],
      }),
    );
    expect(
      screen.getByRole("heading", { name: "项目对话" }),
    ).toBeInTheDocument();
  });

  it("keeps project history visible while the requirement branch opens", () => {
    const requirement = {
      id: "requirement-1",
      project_id: "current",
      title: "登录改造",
      original_message: "改造登录",
      origin: "project_chat_branch" as const,
      status: "analyzing" as const,
      messages: [],
      clarification_round: 0,
      clarifications: [],
      draft: null,
      execution_plan: null,
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    render(
      <AstryxChatSurface
        data={data({
          requirement: null,
          conversation: null,
          requirementOpeningId: requirement.id,
          requirementTimeline: [
            branch(null, null, {
              requirementId: requirement.id,
              opening: true,
              createdAt: requirement.created_at,
            }),
          ],
          projectChat: {
            project_id: "current",
            messages: [
              {
                role: "assistant",
                content: "现有项目讨论",
                created_at: "2026-07-10T00:00:00Z",
              },
            ],
            running: false,
            error: null,
            updated_at: "2026-07-10T00:00:00Z",
          },
        })}
      />,
    );

    expect(screen.getByText("现有项目讨论")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "项目对话" }),
    ).toBeInTheDocument();
    expect(screen.getByText("正在打开需求分支")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "需求输入" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
  });

  it("opens the requirement branch when live activity arrives before its snapshot", async () => {
    const requirement = {
      id: "requirement-1",
      project_id: "current",
      title: "登录改造",
      original_message: "改造登录",
      origin: "project_chat_branch" as const,
      status: "analyzing" as const,
      messages: [],
      clarification_round: 0,
      clarifications: [],
      draft: null,
      execution_plan: null,
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    render(
      <AstryxChatSurface
        data={data({
          requirement,
          conversation: null,
          requirementTimeline: [branch(requirement, null)],
          streamEvents: [
            {
              requirement_id: requirement.id,
              event: "agent.event",
              message: "",
              pi_type: "message_update",
              payload: {
                type: "message_update",
                assistantMessageEvent: {
                  type: "thinking_delta",
                  delta: "正在梳理需求",
                },
              },
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "项目对话" }),
    ).toBeInTheDocument();
    expect(screen.getByText("需求分支")).toBeInTheDocument();
    expect(await screen.findByText("正在梳理需求")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "运行中" })).toBeInTheDocument();
  });

  it("shows creation errors in the project composer", async () => {
    const view = render(<AstryxChatSurface data={data()} />);
    const input = screen.getByRole("combobox", { name: "项目聊天输入" });
    fireEvent.input(input, {
      target: { textContent: "/需求生成 重写登录流程" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    view.rerender(
      <AstryxChatSurface data={data({ busy: true, error: null })} />,
    );
    view.rerender(
      <AstryxChatSurface data={data({ busy: false, error: "创建失败" })} />,
    );

    await waitFor(() =>
      expect(screen.getByText("创建失败")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("combobox", { name: "项目聊天输入" }),
    ).toBeInTheDocument();
  });

  it("blocks concurrent project messages while keeping stop available", () => {
    const onProjectChatAbort = vi.fn(async () => {});
    render(
      <AstryxChatSurface
        data={data({
          projectChat: {
            project_id: "current",
            messages: [],
            running: true,
            error: null,
            updated_at: "2026-07-10T00:00:00Z",
          },
          onProjectChatAbort,
        })}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "项目聊天输入" }),
    ).toHaveAttribute("contenteditable", "false");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onProjectChatAbort).toHaveBeenCalledOnce();
  });

  it("shows live thinking before the running snapshot arrives", async () => {
    const view = render(
      <AstryxChatSurface
        data={data({
          projectChatEvents: [
            {
              type: "agent.event",
              payload: {
                project_id: "current",
                pi_type: "message_update",
                event: {
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "thinking_delta",
                    delta: "正在检查仓库",
                  },
                },
              },
            },
          ],
        })}
      />,
    );

    const liveTrigger = await screen.findByRole("button", {
      name: /思考中/,
    });
    expect(liveTrigger).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("正在检查仓库")).toBeVisible();
    expect(screen.getByTestId("astryx-thinking-bubble")).toBeInTheDocument();

    view.rerender(
      <AstryxChatSurface
        data={data({
          projectChat: {
            project_id: "current",
            messages: [
              {
                role: "assistant",
                content: "检查完成",
                created_at: "2026-07-10T00:00:00Z",
                metadata: {
                  type: "pi_trace",
                  version: 2,
                  trace: {
                    blocks: [
                      {
                        id: "thinking-1",
                        type: "thinking",
                        content: "正在检查仓库",
                        status: "done",
                      },
                    ],
                    thinking: "正在检查仓库",
                    output: "检查完成",
                    tools: [],
                    statuses: [],
                  },
                },
              },
            ],
            running: false,
            error: null,
            updated_at: "2026-07-10T00:00:01Z",
          },
          projectChatEvents: [],
        })}
      />,
    );

    const completedTrigger = await screen.findByRole("button", {
      name: /思考过程/,
    });
    expect(completedTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("renders persisted tools in one Astryx tool group", () => {
    const blocks = ["read", "search", "edit", "test"].map(
      (toolName, index) => ({
        id: `tool-${index}`,
        type: "tool" as const,
        toolCallId: `tool-${index}`,
        toolName,
        output: "done",
        status: "done",
      }),
    );
    render(
      <AstryxChatSurface
        data={data({
          projectChat: {
            project_id: "current",
            messages: [
              {
                role: "assistant",
                content: "完成",
                created_at: "2026-07-10T00:00:00Z",
                metadata: {
                  type: "pi_trace",
                  version: 2,
                  trace: {
                    blocks,
                    thinking: "",
                    output: "完成",
                    tools: [],
                    statuses: [],
                  },
                },
              },
            ],
            running: false,
            error: null,
            updated_at: "2026-07-10T00:00:01Z",
          },
        })}
      />,
    );

    expect(screen.getAllByTestId("astryx-tool-calls")).toHaveLength(1);
    expect(screen.getByLabelText("Pi Agent")).toBeInTheDocument();
  });

  it("renders live tool lifecycles in one Astryx tool group", () => {
    const projectChatEvents = ["read", "search", "edit", "test"].flatMap(
      (toolName, index) =>
        [
          "tool_execution_start",
          "tool_execution_update",
          "tool_execution_end",
        ].map((piType) => ({
          type: "agent.event" as const,
          payload: {
            project_id: "current",
            pi_type: piType,
            event: {
              type: piType,
              toolCallId: `tool-${index}`,
              toolName,
            },
          },
        })),
    );

    render(<AstryxChatSurface data={data({ projectChatEvents })} />);

    expect(screen.getAllByTestId("astryx-tool-calls")).toHaveLength(1);
  });
});
