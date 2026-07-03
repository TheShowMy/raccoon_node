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

it("opens the settings node on basic settings and closes it", async () => {
  const { result } = renderHook(() => useModelSettings());
  await waitFor(() => expect(result.current.basicSettings).not.toBeNull());

  act(() => result.current.openSettings());
  expect(result.current.settingsExpanded).toBe(true);
  expect(result.current.settingsPage).toBe("basic");

  await act(async () => result.current.openModelSettings());
  expect(result.current.settingsPage).toBe("models");

  act(() => result.current.closeSettings());
  expect(result.current.settingsExpanded).toBe(false);
});

it("switches theme immediately, saves only theme, and preserves other drafts", async () => {
  let finishSave: (saved: BasicSettings) => void = () => {};
  vi.mocked(saveBasicSettings).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  const onThemeChange = vi.fn();
  const { result } = renderHook(() => useModelSettings(onThemeChange));
  await waitFor(() => expect(result.current.basicSettings).not.toBeNull());
  act(() =>
    result.current.updateBasicSettings(
      settings({ host: "0.0.0.0", port: 4321 }),
    ),
  );

  let saving = Promise.resolve();
  act(() => {
    saving = result.current.changeTheme("light");
  });
  expect(result.current.basicSettings?.theme).toBe("light");
  expect(onThemeChange).toHaveBeenCalledWith("light");
  expect(saveBasicSettings).toHaveBeenCalledWith({ theme: "light" });

  finishSave(settings({ theme: "light" }));
  await act(async () => saving);
  expect(result.current.basicSettings).toMatchObject({
    theme: "light",
    host: "0.0.0.0",
    port: 4321,
  });
});

it("rolls theme back when persistence fails", async () => {
  vi.mocked(saveBasicSettings).mockRejectedValue(new Error("offline"));
  const onThemeChange = vi.fn();
  const { result } = renderHook(() => useModelSettings(onThemeChange));
  await waitFor(() => expect(result.current.basicSettings).not.toBeNull());

  await act(async () => result.current.changeTheme("light"));

  expect(result.current.basicSettings?.theme).toBe("dark");
  expect(onThemeChange).toHaveBeenLastCalledWith("dark");
  expect(result.current.basicSettingsError).toContain("offline");
});

it("saves runtime fields without resubmitting theme", async () => {
  vi.mocked(saveBasicSettings).mockResolvedValue(
    settings({ host: "0.0.0.0", port: 4321, restart_required: true }),
  );
  const { result } = renderHook(() => useModelSettings());
  await waitFor(() => expect(result.current.basicSettings).not.toBeNull());
  act(() =>
    result.current.updateBasicSettings(
      settings({ host: "0.0.0.0", port: 4321 }),
    ),
  );

  await act(async () => {
    await result.current.saveBasicSettings(true);
  });

  expect(saveBasicSettings).toHaveBeenCalledWith({
    host: "0.0.0.0",
    port: 4321,
    commit_mode: "local",
    confirmed_external: true,
  });
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
