import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import ProjectSettingsNode from "./ProjectSettingsNode";

vi.mock("../terminal/TerminalSessionView", () => ({
  default: () => <div data-testid="embedded-pi-terminal" />,
}));

const basicSettings = {
  theme: "dark" as const,
  host: "0.0.0.0",
  port: 3001,
  host_overridden: false,
  port_overridden: false,
  effective_host: "127.0.0.1",
  effective_port: 3001,
  restart_required: false,
  commit_mode: "local" as const,
};

function data(
  overrides: Partial<Extract<StartNodeData, { kind: "project-settings" }>> = {},
): Extract<StartNodeData, { kind: "project-settings" }> {
  return {
    kind: "project-settings",
    expanded: true,
    page: "basic",
    basicSettings,
    basicError: null,
    savingBasic: false,
    savingTheme: false,
    modelSettings: {
      low: { model_id: null, thinking_level: "low" },
      medium: { model_id: null, thinking_level: "medium" },
      high: { model_id: null, thinking_level: "high" },
    },
    models: [],
    modelRpcStatus: "ready",
    modelError: null,
    savingModels: false,
    terminalDisabled: false,
    terminalAccessRequired: false,
    terminalAccessAuthorized: true,
    terminalAccessBusy: false,
    terminalAccessError: null,
    piLoginSession: null,
    piLoginBusy: false,
    piLoginError: null,
    needsModelOnboarding: true,
    modelDraftComplete: false,
    modelSavedComplete: false,
    onToggleExpanded: vi.fn(),
    onOpenBasic: vi.fn(),
    onOpenModels: vi.fn(),
    onBasicChange: vi.fn(),
    onThemeChange: vi.fn(async () => {}),
    onSaveBasic: vi.fn(async () => null),
    onModelChange: vi.fn(),
    onSaveModels: vi.fn(async () => {}),
    onReloadModels: vi.fn(async () => {}),
    onAuthorizeTerminalAccess: vi.fn(async () => true),
    onStartPiLogin: vi.fn(async () => {}),
    onClosePiLogin: vi.fn(async () => {}),
    ...overrides,
  };
}

it("renders a compact settings entry while collapsed", () => {
  const props = data({ expanded: false });
  render(<ProjectSettingsNode data={props} />);

  const settingsButton = screen.getByRole("button", { name: /设置/ });
  expect(settingsButton).toHaveAttribute("data-model-setup-target", "settings");
  fireEvent.click(settingsButton);
  expect(props.onToggleExpanded).toHaveBeenCalledOnce();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
});

it("switches pages and keeps external-listening confirmation inside the node", () => {
  const props = data();
  render(<ProjectSettingsNode data={props} />);

  const modelsTab = screen.getByRole("tab", { name: "模型设置" });
  expect(modelsTab).toHaveAttribute("data-model-setup-target", "models");
  fireEvent.click(modelsTab);
  expect(props.onOpenModels).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: "保存并按需重启" }));
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  expect(props.onSaveBasic).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "我了解风险，继续" }));
  expect(props.onSaveBasic).toHaveBeenCalledWith(true);
});

it("embeds Pi login actions and onboarding in the model page", () => {
  const props = data({ page: "models" });
  render(<ProjectSettingsNode data={props} />);

  expect(
    screen.getByRole("list", { name: "首次模型配置引导" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Pi 登录终端" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "启动终端" }));
  fireEvent.click(screen.getByRole("button", { name: "重载模型" }));
  expect(props.onStartPiLogin).toHaveBeenCalledOnce();
  expect(props.onReloadModels).toHaveBeenCalledOnce();
});

it("offers restart and close without expanding the project terminal", () => {
  const props = data({
    page: "models",
    piLoginSession: {
      id: "pi-login",
      project_id: "current",
      title: "Pi 登录",
      command: "pi --no-session --no-extensions --no-context-files",
      status: "running",
      exit_code: null,
      created_at: "2026-07-03T00:00:00Z",
      updated_at: "2026-07-03T00:00:00Z",
    },
  });
  render(<ProjectSettingsNode data={props} />);

  fireEvent.click(screen.getByRole("button", { name: "重新启动" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(props.onStartPiLogin).toHaveBeenCalledOnce();
  expect(props.onClosePiLogin).toHaveBeenCalledOnce();
  expect(props.onToggleExpanded).not.toHaveBeenCalled();
});

it("hides onboarding after all three saved tiers are complete", () => {
  render(
    <ProjectSettingsNode
      data={data({
        page: "models",
        needsModelOnboarding: false,
        modelDraftComplete: true,
        modelSavedComplete: true,
      })}
    />,
  );

  expect(
    screen.queryByRole("list", { name: "首次模型配置引导" }),
  ).not.toBeInTheDocument();
  expect(
    document.querySelector(".model-settings--guided"),
  ).not.toBeInTheDocument();
});
