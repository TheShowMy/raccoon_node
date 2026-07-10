import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import AstryxChatSurface from "./AstryxChatSurface";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

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
    promptDismissed: false,
    input: "",
    references: [],
    images: [],
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
    projectChatReferences: [],
    projectChatImages: [],
    projectChatBusy: false,
    projectChatError: null,
    projectChatEvents: [],
    answers: {},
    onInputChange: vi.fn(),
    onReferencesChange: vi.fn(),
    onImagesChange: vi.fn(),
    onSend: vi.fn(async () => {}),
    onProjectChatInputChange: vi.fn(),
    onProjectChatReferencesChange: vi.fn(),
    onProjectChatImagesChange: vi.fn(),
    onProjectChatSend: vi.fn(async () => {}),
    onProjectChatAbort: vi.fn(async () => {}),
    onProjectChatGenerateRequirement: vi.fn(async () => {}),
    onProjectChatReset: vi.fn(async () => {}),
    onRetryRequirementSummarySync: vi.fn(async () => {}),
    onOpenRequirement: vi.fn(),
    onAnswerChange: vi.fn(),
    onSubmitClarifications: vi.fn(async () => {}),
    onConfirm: vi.fn(async () => {}),
    onRetryAnalysis: vi.fn(async () => {}),
    onContinueEditing: vi.fn(),
    onCancel: vi.fn(),
    onAbandon: vi.fn(),
    ...overrides,
  };
}

describe("AstryxChatSurface", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
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
  });

  it("renders a requirement confirmation in the composer drawer", () => {
    const onConfirm = vi.fn(async () => {});
    const requirement = {
      id: "requirement-1",
      project_id: "current",
      title: "登录改造",
      original_message: "改造登录",
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
      pi_session_file: null,
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    render(
      <AstryxChatSurface
        data={data({
          requirement,
          conversation: {
            id: requirement.id,
            project_id: "current",
            title: requirement.title,
            status: "draft_ready",
            running: false,
            items: [],
            prompt: {
              type: "confirmation",
              draft: requirement.draft,
              prompt_id: "prompt-1",
              revision: 2,
            },
            error: null,
            updated_at: "2026-07-10T00:00:00Z",
          },
          onConfirm,
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "需求分支" }),
    ).toBeInTheDocument();
    expect(screen.getByText("更新登录流程")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认需求" }));
    expect(onConfirm).toHaveBeenCalledWith(requirement);
  });

  it("starts a requirement branch directly from an inline command", async () => {
    const onSend = vi.fn(async () => {});
    render(<AstryxChatSurface data={data({ onSend })} />);
    const input = screen.getByRole("combobox", { name: "项目聊天输入" });

    fireEvent.input(input, {
      target: { textContent: "/需求生成 重写登录流程" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("重写登录流程"));
    expect(
      screen.getByRole("heading", { name: "需求分支" }),
    ).toBeInTheDocument();
  });

  it("keeps requirement input visible after creation fails", async () => {
    const view = render(<AstryxChatSurface data={data()} />);
    const input = screen.getByRole("combobox", { name: "项目聊天输入" });
    fireEvent.input(input, { target: { textContent: "/需求生成" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      screen.getByRole("combobox", { name: "需求输入" }),
    ).toBeInTheDocument();
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
      screen.getByRole("combobox", { name: "需求输入" }),
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
});
