import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  getBasicSettings,
  getModelSettings,
  saveBasicSettings,
} from "../api/client";
import type { BasicSettings } from "../types/api";
import { useModelSettings } from "./useModelSettings";

vi.mock("../api/client", () => ({
  getBasicSettings: vi.fn(),
  getModelSettings: vi.fn(),
  reloadModelSettings: vi.fn(),
  saveBasicSettings: vi.fn(),
  saveModelSettings: vi.fn(),
}));

const settings = (overrides: Partial<BasicSettings> = {}): BasicSettings => ({
  theme: "dark",
  host: "127.0.0.1",
  port: 3000,
  host_overridden: false,
  port_overridden: false,
  effective_host: "127.0.0.1",
  effective_port: 3000,
  restart_required: false,
  commit_mode: "local",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBasicSettings).mockResolvedValue(settings());
  vi.mocked(getModelSettings).mockResolvedValue({
    models: [],
    settings: {
      low: { model_id: null, thinking_level: "low" },
      medium: { model_id: null, thinking_level: "medium" },
      high: { model_id: null, thinking_level: "high" },
    },
    rpc_status: "ready",
    rpc_error: null,
  });
});

it("opens the drawer directly on basic settings and closes it", async () => {
  const { result } = renderHook(() => useModelSettings());
  await waitFor(() => expect(result.current.basicSettings).not.toBeNull());

  act(() => result.current.openSettings());
  expect(result.current.settingsView).toBe("basic");

  await act(async () => result.current.openModelSettings());
  expect(result.current.settingsView).toBe("models");

  act(() => result.current.closeSettings());
  expect(result.current.settingsView).toBe("closed");
});

it("saves host and confirmation while applying the theme immediately", async () => {
  vi.mocked(saveBasicSettings).mockResolvedValue(
    settings({
      theme: "light",
      host: "0.0.0.0",
      port: 4321,
      effective_host: "0.0.0.0",
      effective_port: 4321,
      commit_mode: "pull_request",
      restart_required: true,
    }),
  );
  const onThemeChange = vi.fn();
  const { result } = renderHook(() => useModelSettings(onThemeChange));
  await waitFor(() => expect(result.current.basicSettings).not.toBeNull());

  act(() =>
    result.current.updateBasicSettings(
      settings({
        theme: "light",
        host: "0.0.0.0",
        port: 4321,
        commit_mode: "pull_request",
      }),
    ),
  );
  await act(async () => {
    await result.current.saveBasicSettings(true);
  });

  expect(saveBasicSettings).toHaveBeenCalledWith({
    theme: "light",
    host: "0.0.0.0",
    port: 4321,
    commit_mode: "pull_request",
    confirmed_external: true,
  });
  expect(onThemeChange).toHaveBeenCalledWith("light");
  expect(result.current.basicSettings?.restart_required).toBe(true);
});

it("rejects an invalid port before calling the API", async () => {
  const { result } = renderHook(() => useModelSettings());
  await waitFor(() => expect(result.current.basicSettings).not.toBeNull());
  act(() => result.current.updateBasicSettings(settings({ port: 0 })));

  await act(async () => {
    await result.current.saveBasicSettings();
  });

  expect(saveBasicSettings).not.toHaveBeenCalled();
  expect(result.current.basicSettingsError).toBe(
    "端口必须是 1 到 65535 之间的整数",
  );
});
