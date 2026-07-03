import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  getBasicSettings,
  getModelSettings,
  saveBasicSettings,
  saveModelSettings,
} from "../api/client";
import type {
  BasicSettings,
  ModelSettings,
  ModelSettingsResponse,
} from "../types/api";
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

const completeModelSettings: ModelSettings = {
  low: { model_id: "provider/model", thinking_level: "low" },
  medium: { model_id: "provider/model", thinking_level: "medium" },
  high: { model_id: "provider/model", thinking_level: "high" },
};

const completeModelResponse = (): ModelSettingsResponse => ({
  models: [
    {
      id: "provider/model",
      provider: "provider",
      name: "Model",
      reasoning: true,
    },
  ],
  settings: completeModelSettings,
  rpc_status: "ready",
  rpc_error: null,
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

it("automatically opens incomplete model setup once per application mount", async () => {
  const { result } = renderHook(() => useModelSettings());
  await waitFor(() => expect(result.current.modelRpcStatus).toBe("ready"));
  expect(result.current.settingsExpanded).toBe(true);
  expect(result.current.settingsPage).toBe("models");
  expect(result.current.needsModelOnboarding).toBe(true);

  act(() => result.current.closeSettings());
  expect(result.current.settingsExpanded).toBe(false);
  await act(async () => result.current.openModelSettings());
  act(() => result.current.closeSettings());
  expect(result.current.settingsExpanded).toBe(false);
});

it("keeps complete saved model setup collapsed", async () => {
  vi.mocked(getModelSettings).mockResolvedValue(completeModelResponse());
  const { result } = renderHook(() => useModelSettings());

  await waitFor(() => expect(result.current.modelRpcStatus).toBe("ready"));
  expect(result.current.settingsExpanded).toBe(false);
  expect(result.current.needsModelOnboarding).toBe(false);
  expect(result.current.modelDraftComplete).toBe(true);
  expect(result.current.modelSavedComplete).toBe(true);
});

it("tracks draft completion separately until all three tiers are saved", async () => {
  vi.mocked(saveModelSettings).mockResolvedValue(completeModelResponse());
  const { result } = renderHook(() => useModelSettings());
  await waitFor(() => expect(result.current.modelRpcStatus).toBe("ready"));

  act(() => {
    result.current.updateModelTier("low", completeModelSettings.low);
    result.current.updateModelTier("medium", completeModelSettings.medium);
    result.current.updateModelTier("high", completeModelSettings.high);
  });
  expect(result.current.modelDraftComplete).toBe(true);
  expect(result.current.modelSavedComplete).toBe(false);

  await act(async () => result.current.saveModelSettings());
  expect(result.current.modelSavedComplete).toBe(true);
  expect(result.current.needsModelOnboarding).toBe(false);
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
