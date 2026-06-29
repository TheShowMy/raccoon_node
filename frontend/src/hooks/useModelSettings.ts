import { useCallback, useState } from "react";
import type {
  BasicSettings,
  ModelSettings,
  ModelTierKey,
  ModelTierSetting,
  SettingsView,
  ThemeMode,
} from "../types/api";
import {
  getBasicSettings,
  getModelSettings,
  saveBasicSettings,
  saveModelSettings,
} from "../api/client";
import { readError, DEFAULT_MODEL_SETTINGS } from "../utils/format";

export function useModelSettings(onThemeChange?: (theme: ThemeMode) => void) {
  const [settingsView, setSettingsView] = useState<SettingsView>("closed");
  const [basicSettings, setBasicSettings] = useState<BasicSettings | null>(
    null,
  );
  const [basicSettingsError, setBasicSettingsError] = useState<string | null>(
    null,
  );
  const [savingBasicSettings, setSavingBasicSettings] = useState(false);
  const [models, setModels] = useState(
    [] as { id: string; name: string; provider: string; reasoning: boolean }[],
  );
  const [draftModelSettings, setDraftModelSettings] = useState<ModelSettings>(
    DEFAULT_MODEL_SETTINGS,
  );
  const [modelRpcStatus, setModelRpcStatus] = useState<
    "idle" | "loading" | "ready" | "reconnecting" | "error"
  >("idle");
  const [modelError, setModelError] = useState<string | null>(null);
  const [savingModels, setSavingModels] = useState(false);

  const loadModelSettings = useCallback(async () => {
    setModelRpcStatus("loading");
    setModelError(null);

    try {
      const data = await getModelSettings();
      setModels(data.models);
      setDraftModelSettings(data.settings);
      setModelRpcStatus(data.rpc_status);
      setModelError(data.rpc_error);
    } catch (reason) {
      setModels([]);
      setModelRpcStatus("error");
      setModelError(readError(reason));
    }
  }, []);

  const openSettings = useCallback(() => setSettingsView("list"), []);

  const openBasicSettings = useCallback(() => {
    setSettingsView("basic");
    setBasicSettingsError(null);
    void getBasicSettings()
      .then(setBasicSettings)
      .catch((reason) => setBasicSettingsError(readError(reason)));
  }, []);

  const openModelSettings = useCallback(() => {
    setSettingsView("models");
    void loadModelSettings();
  }, [loadModelSettings]);

  const closeSettingsDetail = useCallback(() => setSettingsView("list"), []);
  const closeSettingsList = useCallback(() => setSettingsView("closed"), []);

  const updateModelTier = useCallback(
    (tier: ModelTierKey, setting: ModelTierSetting) => {
      setDraftModelSettings((current) => ({
        ...current,
        [tier]: setting,
      }));
    },
    [],
  );

  const saveModelSettingsCallback = useCallback(async () => {
    setSavingModels(true);
    setModelError(null);

    try {
      const data = await saveModelSettings(draftModelSettings);
      setModels(data.models);
      setDraftModelSettings(data.settings);
      setModelRpcStatus(data.rpc_status);
      setModelError(data.rpc_error);
      setSettingsView("list");
    } catch (reason) {
      setModelError(readError(reason));
    } finally {
      setSavingModels(false);
    }
  }, [draftModelSettings]);

  const saveBasicSettingsCallback = useCallback(async () => {
    if (
      !basicSettings ||
      !Number.isInteger(basicSettings.port) ||
      basicSettings.port < 1 ||
      basicSettings.port > 65535
    ) {
      setBasicSettingsError("端口必须是 1 到 65535 之间的整数");
      return;
    }
    setSavingBasicSettings(true);
    setBasicSettingsError(null);
    try {
      const saved = await saveBasicSettings({
        theme: basicSettings.theme,
        port: basicSettings.port,
      });
      setBasicSettings(saved);
      onThemeChange?.(saved.theme);
      setSettingsView("list");
    } catch (reason) {
      setBasicSettingsError(readError(reason));
    } finally {
      setSavingBasicSettings(false);
    }
  }, [basicSettings, onThemeChange]);

  return {
    settingsView,
    openSettings,
    openBasicSettings,
    openModelSettings,
    closeSettingsDetail,
    closeSettingsList,
    basicSettings,
    basicSettingsError,
    savingBasicSettings,
    updateBasicSettings: setBasicSettings,
    saveBasicSettings: saveBasicSettingsCallback,
    models,
    draftModelSettings,
    modelRpcStatus,
    modelError,
    savingModels,
    updateModelTier,
    saveModelSettings: saveModelSettingsCallback,
  };
}
