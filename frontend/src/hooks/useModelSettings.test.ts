import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getBasicSettings, saveBasicSettings } from "../api/client";
import { useModelSettings } from "./useModelSettings";

vi.mock("../api/client", () => ({
  getBasicSettings: vi.fn(),
  getModelSettings: vi.fn(),
  saveBasicSettings: vi.fn(),
  saveModelSettings: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

it("navigates settings in one mutually exclusive state", async () => {
  vi.mocked(getBasicSettings).mockResolvedValue({
    theme: "dark",
    host: "127.0.0.1",
    port: 3000,
    port_overridden: false,
    commit_mode: "local",
  });
  const { result } = renderHook(() => useModelSettings());

  act(() => result.current.openSettings());
  expect(result.current.settingsView).toBe("list");

  await act(async () => result.current.openBasicSettings());
  expect(result.current.settingsView).toBe("basic");
  expect(result.current.basicSettings?.port).toBe(3000);

  act(() => result.current.closeSettingsDetail());
  expect(result.current.settingsView).toBe("list");

  act(() => result.current.closeSettingsList());
  expect(result.current.settingsView).toBe("closed");
});

it("applies a saved theme immediately and returns to the settings list", async () => {
  vi.mocked(getBasicSettings).mockResolvedValue({
    theme: "dark",
    host: "127.0.0.1",
    port: 3000,
    port_overridden: false,
    commit_mode: "local",
  });
  vi.mocked(saveBasicSettings).mockResolvedValue({
    theme: "light",
    host: "127.0.0.1",
    port: 4321,
    port_overridden: false,
    commit_mode: "pull_request",
  });
  const onThemeChange = vi.fn();
  const { result } = renderHook(() => useModelSettings(onThemeChange));

  await act(async () => result.current.openBasicSettings());
  act(() =>
    result.current.updateBasicSettings({
      theme: "light",
      host: "127.0.0.1",
      port: 4321,
      port_overridden: false,
      commit_mode: "pull_request",
    }),
  );
  await act(async () => result.current.saveBasicSettings());

  expect(saveBasicSettings).toHaveBeenCalledWith({
    theme: "light",
    port: 4321,
    commit_mode: "pull_request",
  });
  expect(onThemeChange).toHaveBeenCalledWith("light");
  expect(result.current.settingsView).toBe("list");
});

it("rejects an invalid port before calling the API", async () => {
  const { result } = renderHook(() => useModelSettings());
  act(() =>
    result.current.updateBasicSettings({
      theme: "dark",
      host: "127.0.0.1",
      port: 0,
      port_overridden: false,
      commit_mode: "local",
    }),
  );

  await act(async () => result.current.saveBasicSettings());

  expect(saveBasicSettings).not.toHaveBeenCalled();
  expect(result.current.basicSettingsError).toBe(
    "端口必须是 1 到 65535 之间的整数",
  );
});
