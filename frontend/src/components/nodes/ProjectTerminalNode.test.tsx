// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectTerminalNode from "./ProjectTerminalNode";

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    loadAddon: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    cols: 80,
    rows: 24,
  })),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })),
}));

const project = {
  id: "current",
  name: "raccoon",
  git_url: "",
  local_path: "/repo",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

const session = {
  id: "term-1",
  project_id: "current",
  title: "dev",
  command: "npm run dev",
  status: "running" as const,
  exit_code: null,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

const profile = {
  id: "p1",
  name: "dev",
  command: "npm run dev",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

function renderNode(overrides: Record<string, unknown> = {}) {
  const onToggleCollapsed = vi.fn();
  const onCreateTerminal = vi.fn(async () => {});
  const onCloseTerminal = vi.fn(async () => {});
  const onSelectTerminal = vi.fn();
  const onSaveCommandProfiles = vi.fn(async () => {});

  const result = render(
    <ProjectTerminalNode
      data={{
        kind: "project-terminal",
        project,
        collapsed: false,
        sessions: [],
        activeSessionId: null,
        commandProfiles: [],
        busy: false,
        error: null,
        terminalDisabled: false,
        onToggleCollapsed,
        onCreateTerminal,
        onCloseTerminal,
        onSelectTerminal,
        onSaveCommandProfiles,
        ...overrides,
      }}
    />,
  );

  return {
    ...result,
    onToggleCollapsed,
    onCreateTerminal,
    onCloseTerminal,
    onSelectTerminal,
    onSaveCommandProfiles,
  };
}

describe("ProjectTerminalNode", () => {
  it("shows collapsed summary when collapsed", () => {
    renderNode({ collapsed: true });
    expect(screen.getByText("项目终端")).toBeInTheDocument();
    expect(screen.getByText("默认在项目根目录启动")).toBeInTheDocument();
  });

  it("toggles collapsed state when header is clicked", () => {
    const { onToggleCollapsed } = renderNode({ collapsed: true });
    fireEvent.click(screen.getByRole("button", { name: /项目终端/ }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("renders empty state when no sessions exist", () => {
    renderNode();
    expect(screen.getByText("还没有终端")).toBeInTheDocument();
    expect(
      screen.getByText(/点击标题栏的“新建”或选择一个命令标签来启动/),
    ).toBeInTheDocument();
  });

  it("calls onCreateTerminal when new button is clicked", () => {
    const { onCreateTerminal } = renderNode();
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(onCreateTerminal).toHaveBeenCalledTimes(1);
  });

  it("disables controls when terminal is disabled", () => {
    renderNode({ terminalDisabled: true });
    expect(screen.getByRole("button", { name: "新建" })).toBeDisabled();
    expect(screen.getByText("终端当前不可用")).toBeInTheDocument();
  });

  it("renders command profiles as clickable chips", () => {
    const { onCreateTerminal } = renderNode({ commandProfiles: [profile] });
    const chip = screen.getByRole("button", { name: /dev/ });
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);
    expect(onCreateTerminal).toHaveBeenCalledWith("npm run dev", "dev");
  });

  it("shows empty command placeholder and opens profile editor", () => {
    renderNode();
    expect(screen.getByText("暂无自定义启动命令")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "管理命令" }));
    expect(screen.getByText("自定义启动命令")).toBeInTheDocument();
  });

  it("adds and saves command profiles", async () => {
    const { onSaveCommandProfiles } = renderNode();
    fireEvent.click(screen.getByRole("button", { name: "管理命令" }));
    fireEvent.click(screen.getByRole("button", { name: "添加命令" }));

    const nameInput = screen.getByPlaceholderText("名称");
    const commandInput = screen.getByPlaceholderText("命令，例如 npm run dev");
    fireEvent.change(nameInput, { target: { value: "test" } });
    fireEvent.change(commandInput, { target: { value: "npm test" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(onSaveCommandProfiles).toHaveBeenCalledWith([
        { name: "test", command: "npm test" },
      ]);
    });
  });

  it("filters out empty profiles before saving", async () => {
    const { onSaveCommandProfiles } = renderNode({
      commandProfiles: [profile],
    });
    fireEvent.click(screen.getByRole("button", { name: "管理命令" }));
    fireEvent.click(screen.getByRole("button", { name: "添加命令" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(onSaveCommandProfiles).toHaveBeenCalledWith([
        { id: "p1", name: "dev", command: "npm run dev" },
      ]);
    });
  });

  it("renders session tabs and selects a session", () => {
    const { onSelectTerminal } = renderNode({
      sessions: [session],
      activeSessionId: "term-1",
    });
    expect(screen.getByText("dev")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "dev" }));
    expect(onSelectTerminal).toHaveBeenCalledWith("term-1");
  });

  it("closes a session when tab close is clicked", async () => {
    const { onCloseTerminal } = renderNode({
      sessions: [session],
      activeSessionId: "term-1",
    });
    fireEvent.click(screen.getByLabelText("关闭终端"));
    await waitFor(() => {
      expect(onCloseTerminal).toHaveBeenCalledWith("term-1");
    });
  });

  it("displays an error pill when error is set", () => {
    renderNode({ error: "connection failed" });
    expect(screen.getByText("connection failed")).toBeInTheDocument();
  });
});
