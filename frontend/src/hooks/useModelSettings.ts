import { useCallback, useEffect, useState } from "react";
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
  reloadModelSettings,
  saveBasicSettings,
  saveModelSettings,
} from "../api/client";
import { readError, DEFAULT_MODEL_SETTINGS } from "../utils/format";

export function useModelSettings(
  onThemeChange?: (theme: ThemeMode) => void,
  onBasicSettingsSaved?: () => Promise<void>,
) {
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

  const loadBasicSettings = useCallback(async () => {
    setBasicSettingsError(null);
    try {
      setBasicSettings(await getBasicSettings());
    } catch (reason) {
      setBasicSettingsError(readError(reason));
    }
  }, []);

  useEffect(() => {
    void loadBasicSettings();
  }, [loadBasicSettings]);

  const openSettings = useCallback(() => {
    setSettingsView("basic");
    void loadBasicSettings();
  }, [loadBasicSettings]);

  const openBasicSettings = useCallback(() => {
    setSettingsView("basic");
    void loadBasicSettings();
  }, [loadBasicSettings]);

  const openModelSettings = useCallback(() => {
    setSettingsView("models");
    void loadModelSettings();
  }, [loadModelSettings]);

  const closeSettings = useCallback(() => setSettingsView("closed"), []);

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
    } catch (reason) {
      setModelError(readError(reason));
    } finally {
      setSavingModels(false);
    }
  }, [draftModelSettings]);

  const reloadModelSettingsCallback = useCallback(async () => {
    setModelRpcStatus("reconnecting");
    setModelError(null);
    try {
      const data = await reloadModelSettings();
      setModels(data.models);
      setDraftModelSettings(data.settings);
      setModelRpcStatus(data.rpc_status);
      setModelError(data.rpc_error);
    } catch (reason) {
      setModelRpcStatus("error");
      setModelError(readError(reason));
    }
  }, []);

  const saveBasicSettingsCallback = useCallback(
    async (confirmedExternal = false): Promise<BasicSettings | null> => {
      if (
        !basicSettings ||
        !Number.isInteger(basicSettings.port) ||
        basicSettings.port < 1 ||
        basicSettings.port > 65535
      ) {
        setBasicSettingsError("端口必须是 1 到 65535 之间的整数");
        return null;
      }
      setSavingBasicSettings(true);
      setBasicSettingsError(null);
      try {
        const saved = await saveBasicSettings({
          theme: basicSettings.theme,
          host: basicSettings.host,
          port: basicSettings.port,
          commit_mode: basicSettings.commit_mode,
          confirmed_external: confirmedExternal,
        });
        setBasicSettings(saved);
        onThemeChange?.(saved.theme);
        try {
          await onBasicSettingsSaved?.();
          return saved;
        } catch (reason) {
          setBasicSettingsError(
            `设置已保存，但刷新项目状态失败：${readError(reason)}`,
          );
          return saved;
        }
      } catch (reason) {
        setBasicSettingsError(readError(reason));
        return null;
      } finally {
        setSavingBasicSettings(false);
      }
    },
    [basicSettings, onBasicSettingsSaved, onThemeChange],
  );

  return {
    settingsView,
    openSettings,
    openBasicSettings,
    openModelSettings,
    closeSettings,
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
    reloadModelSettings: reloadModelSettingsCallback,
  };
}
