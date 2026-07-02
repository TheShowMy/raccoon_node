import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import SettingsDrawer from "./SettingsDrawer";

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

it("switches drawer pages and requires confirmation for external listening", () => {
  const onView = vi.fn();
  const onSaveBasic = vi.fn(async () => null);
  render(
    <SettingsDrawer
      view="basic"
      basicSettings={basicSettings}
      basicError={null}
      savingBasic={false}
      modelSettings={{
        low: { model_id: null, thinking_level: "low" },
        medium: { model_id: null, thinking_level: "medium" },
        high: { model_id: null, thinking_level: "high" },
      }}
      models={[]}
      modelRpcStatus="ready"
      modelError={null}
      savingModels={false}
      terminalDisabled={false}
      onView={onView}
      onClose={vi.fn()}
      onBasicChange={vi.fn()}
      onSaveBasic={onSaveBasic}
      onModelChange={vi.fn()}
      onSaveModels={vi.fn(async () => {})}
      onReloadModels={vi.fn(async () => {})}
      onOpenLogin={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "模型设置" }));
  expect(onView).toHaveBeenCalledWith("models");

  fireEvent.click(screen.getByRole("button", { name: "保存并按需重启" }));
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  expect(onSaveBasic).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "我了解风险，继续" }));
  expect(onSaveBasic).toHaveBeenCalledWith(true);
});

it("opens the Pi login terminal and reloads RPC models", () => {
  const onOpenLogin = vi.fn();
  const onReloadModels = vi.fn(async () => {});
  render(
    <SettingsDrawer
      view="models"
      basicSettings={{ ...basicSettings, host: "127.0.0.1" }}
      basicError={null}
      savingBasic={false}
      modelSettings={{
        low: { model_id: null, thinking_level: "low" },
        medium: { model_id: null, thinking_level: "medium" },
        high: { model_id: null, thinking_level: "high" },
      }}
      models={[]}
      modelRpcStatus="ready"
      modelError={null}
      savingModels={false}
      terminalDisabled={false}
      onView={vi.fn()}
      onClose={vi.fn()}
      onBasicChange={vi.fn()}
      onSaveBasic={vi.fn(async () => null)}
      onModelChange={vi.fn()}
      onSaveModels={vi.fn(async () => {})}
      onReloadModels={onReloadModels}
      onOpenLogin={onOpenLogin}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "打开 Pi 登录终端" }));
  fireEvent.click(screen.getByRole("button", { name: "重载 Pi 模型" }));
  expect(onOpenLogin).toHaveBeenCalledOnce();
  expect(onReloadModels).toHaveBeenCalledOnce();
});
