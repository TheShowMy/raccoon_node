import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TerminalWorkbench from "./TerminalWorkbench";
import type { TerminalWorkbenchModel } from "../../types/viewModels";

const baseData: TerminalWorkbenchModel = {
  project: {
    name: "current",
    git_url: "",
    local_path: "",
  },
  sessions: [],
  activeSessionId: null,
  commandProfiles: [],
  busy: false,
  error: null,
  terminalDisabled: true,
  terminalDisabledReason: "terminal-authorization-required",
  terminalAccessRequired: true,
  terminalAccessAuthorized: false,
  terminalAccessBusy: false,
  terminalAccessError: null,
  onAuthorizeTerminalAccess: vi.fn(),
  onCreateTerminal: vi.fn(),
  onCloseTerminal: vi.fn(),
  onSelectTerminal: vi.fn(),
};

describe("TerminalWorkbench", () => {
  it("renders a centered authorization card when terminal is disabled", () => {
    render(<TerminalWorkbench data={baseData} />);

    expect(screen.getByText("终端需要启动密钥")).toBeInTheDocument();
    expect(
      screen.getByText("监听 0.0.0.0 时需要输入本次启动的终端密钥"),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("输入启动密钥")).toBeInTheDocument();
    expect(screen.getByText("终端未启用")).toBeInTheDocument();
  });

  it("renders a localhost-only notice for non-localhost access", () => {
    render(
      <TerminalWorkbench
        data={{
          ...baseData,
          terminalDisabledReason: "non-localhost-access",
        }}
      />,
    );

    expect(screen.getByText("终端仅支持本地访问")).toBeInTheDocument();
    expect(
      screen.getByText("当前主机不是 localhost 或 127.0.0.1，终端功能不可用。"),
    ).toBeInTheDocument();
  });

  it("renders the authorization card when access is required", () => {
    render(
      <TerminalWorkbench
        data={{
          ...baseData,
          terminalDisabled: false,
          terminalAccessRequired: true,
          terminalAccessAuthorized: false,
        }}
      />,
    );

    expect(screen.getByText("终端需要授权")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("输入启动密钥")).toBeInTheDocument();
  });

  it("renders the empty session prompt when terminal is available", () => {
    render(
      <TerminalWorkbench
        data={{
          ...baseData,
          terminalDisabled: false,
          terminalAccessRequired: false,
          terminalAccessAuthorized: false,
        }}
      />,
    );

    expect(screen.getByText("新建或选择一个终端会话")).toBeInTheDocument();
  });
});
