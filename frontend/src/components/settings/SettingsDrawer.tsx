import { useEffect, useState } from "react";
import { Settings, SlidersHorizontal, X } from "lucide-react";
import type {
  BasicSettings,
  ModelSettings,
  ModelTierKey,
  ModelTierSetting,
  PiModel,
  SettingsView,
} from "../../types/api";
import { restartApplication } from "../../api/client";
import { readError } from "../../utils/format";
import BasicSettingsPanel from "./BasicSettingsPanel";
import ModelSettingsPanel from "./ModelSettingsPanel";

export async function waitForService(
  nextUrl: string,
  fetcher: typeof fetch = fetch,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetcher(nextUrl, { mode: "no-cors", cache: "no-store" });
      return;
    } catch {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
  }
  throw new Error("服务未在预期时间内恢复");
}

export default function SettingsDrawer({
  view,
  basicSettings,
  basicError,
  savingBasic,
  modelSettings,
  models,
  modelRpcStatus,
  modelError,
  savingModels,
  terminalDisabled,
  onView,
  onClose,
  onBasicChange,
  onSaveBasic,
  onModelChange,
  onSaveModels,
  onReloadModels,
  onOpenLogin,
}: {
  view: SettingsView;
  basicSettings: BasicSettings | null;
  basicError: string | null;
  savingBasic: boolean;
  modelSettings: ModelSettings;
  models: PiModel[];
  modelRpcStatus: "idle" | "loading" | "ready" | "reconnecting" | "error";
  modelError: string | null;
  savingModels: boolean;
  terminalDisabled: boolean;
  onView: (view: "basic" | "models") => void;
  onClose: () => void;
  onBasicChange: (settings: BasicSettings) => void;
  onSaveBasic: (confirmedExternal?: boolean) => Promise<BasicSettings | null>;
  onModelChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
  onSaveModels: () => Promise<void>;
  onReloadModels: () => Promise<void>;
  onOpenLogin: () => void;
}) {
  const [confirmExternal, setConfirmExternal] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  useEffect(() => {
    if (view === "closed") return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, view]);

  if (view === "closed") return null;

  const saveBasic = async (confirmed = false) => {
    if (basicSettings?.host === "0.0.0.0" && !confirmed) {
      setConfirmExternal(true);
      return;
    }
    setConfirmExternal(false);
    setRestartError(null);
    const saved = await onSaveBasic(confirmed);
    if (!saved?.restart_required) return;

    setRestarting(true);
    try {
      const { next_url: nextUrl } = await restartApplication();
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      await waitForService(nextUrl);
      window.location.assign(nextUrl);
    } catch (reason) {
      setRestartError(`设置已保存，但重启失败：${readError(reason)}`);
      setRestarting(false);
    }
  };

  return (
    <div className="settings-drawer-layer" role="presentation">
      <button
        className="settings-drawer-backdrop"
        type="button"
        aria-label="关闭设置"
        onClick={onClose}
      />
      <aside className="settings-drawer" aria-label="设置中心">
        <header>
          <div>
            <Settings size={20} />
            <span>
              <strong>设置中心</strong>
              <small>Raccoon Node</small>
            </span>
          </div>
          <button type="button" aria-label="关闭设置" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <nav className="settings-drawer__tabs">
          <button
            type="button"
            className={view === "basic" ? "active" : ""}
            onClick={() => onView("basic")}
          >
            <Settings size={16} />
            基础设置
          </button>
          <button
            type="button"
            className={view === "models" ? "active" : ""}
            onClick={() => onView("models")}
          >
            <SlidersHorizontal size={16} />
            模型设置
          </button>
        </nav>
        <div className="settings-drawer__body">
          {restartError ? <p className="form-error">{restartError}</p> : null}
          {restarting ? (
            <p className="settings-drawer__notice">服务正在重启，等待恢复…</p>
          ) : null}
          {view === "basic" ? (
            <BasicSettingsPanel
              settings={basicSettings}
              error={basicError}
              saving={savingBasic || restarting}
              onChange={onBasicChange}
              onSave={() => void saveBasic()}
            />
          ) : (
            <ModelSettingsPanel
              settings={modelSettings}
              models={models}
              rpcStatus={modelRpcStatus}
              error={modelError}
              saving={savingModels}
              terminalDisabled={terminalDisabled}
              onChange={onModelChange}
              onSave={() => void onSaveModels()}
              onLogin={onOpenLogin}
              onReload={() => void onReloadModels()}
            />
          )}
        </div>
      </aside>

      {confirmExternal ? (
        <div className="settings-confirm" role="alertdialog" aria-modal="true">
          <strong>确认监听所有网络接口？</strong>
          <p>
            当前 API 没有身份验证。使用 0.0.0.0
            后，同一网络中的设备可能访问项目数据和操作接口。
          </p>
          <div>
            <button type="button" onClick={() => setConfirmExternal(false)}>
              取消
            </button>
            <button
              className="settings-danger"
              type="button"
              onClick={() => void saveBasic(true)}
            >
              我了解风险，继续
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
