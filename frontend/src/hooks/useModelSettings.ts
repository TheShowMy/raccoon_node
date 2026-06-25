import { useCallback, useState } from "react";
import type {
  ModelSettings,
  ModelTierKey,
  ModelTierSetting,
} from "../types/api";
import { getModelSettings, saveModelSettings } from "../api/client";
import { readError, DEFAULT_MODEL_SETTINGS } from "../utils/format";

export function useModelSettings(onSaved: () => Promise<void>) {
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
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

  const toggleModelSettings = useCallback(() => {
    setModelSettingsOpen((open) => {
      if (open) {
        return false;
      }

      void loadModelSettings();
      return true;
    });
  }, [loadModelSettings]);

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
      await onSaved();
      setModelSettingsOpen(false);
    } catch (reason) {
      setModelError(readError(reason));
    } finally {
      setSavingModels(false);
    }
  }, [draftModelSettings, onSaved]);

  return {
    modelSettingsOpen,
    setModelSettingsOpen,
    models,
    draftModelSettings,
    modelRpcStatus,
    modelError,
    savingModels,
    toggleModelSettings,
    updateModelTier,
    saveModelSettings: saveModelSettingsCallback,
  };
}
