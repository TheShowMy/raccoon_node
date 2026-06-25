// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import RequirementChatNode from "./RequirementChatNode";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

function data(projectId: string): ChatData {
  return {
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
  };
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
});
