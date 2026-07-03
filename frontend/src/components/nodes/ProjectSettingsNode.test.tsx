import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import ProjectSettingsNode from "./ProjectSettingsNode";

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
    onToggleExpanded: vi.fn(),
    onOpenBasic: vi.fn(),
    onOpenModels: vi.fn(),
    onBasicChange: vi.fn(),
    onThemeChange: vi.fn(async () => {}),
    onSaveBasic: vi.fn(async () => null),
    onModelChange: vi.fn(),
    onSaveModels: vi.fn(async () => {}),
    onReloadModels: vi.fn(async () => {}),
    onOpenLogin: vi.fn(),
    ...overrides,
  };
}

it("renders a compact settings entry while collapsed", () => {
  const props = data({ expanded: false });
  render(<ProjectSettingsNode data={props} />);

  fireEvent.click(screen.getByRole("button", { name: /设置/ }));
  expect(props.onToggleExpanded).toHaveBeenCalledOnce();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
});

it("switches pages and keeps external-listening confirmation inside the node", () => {
  const props = data();
  render(<ProjectSettingsNode data={props} />);

  fireEvent.click(screen.getByRole("button", { name: "模型设置" }));
  expect(props.onOpenModels).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: "保存并按需重启" }));
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  expect(props.onSaveBasic).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "我了解风险，继续" }));
  expect(props.onSaveBasic).toHaveBeenCalledWith(true);
});

it("keeps Pi login and model reload actions in the model page", () => {
  const props = data({ page: "models" });
  render(<ProjectSettingsNode data={props} />);

  fireEvent.click(screen.getByRole("button", { name: "打开 Pi 登录终端" }));
  fireEvent.click(screen.getByRole("button", { name: "重载 Pi 模型" }));
  expect(props.onOpenLogin).toHaveBeenCalledOnce();
  expect(props.onReloadModels).toHaveBeenCalledOnce();
});
