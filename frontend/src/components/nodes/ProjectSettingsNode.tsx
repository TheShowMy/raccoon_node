import { useCallback, useState } from "react";
import type React from "react";
import { AlertTriangle, Settings, SlidersHorizontal } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { restartApplication } from "../../api/client";
import { readError } from "../../utils/format";
import BasicSettingsPanel from "../settings/BasicSettingsPanel";
import ModelSettingsPanel from "../settings/ModelSettingsPanel";
import NodeBar from "../ui/NodeBar";

type SettingsData = Extract<StartNodeData, { kind: "project-settings" }>;

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

export default function ProjectSettingsNode({ data }: { data: SettingsData }) {
  const [confirmExternal, setConfirmExternal] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const saveBasic = useCallback(
    async (confirmed = false) => {
      if (data.basicSettings?.host === "0.0.0.0" && !confirmed) {
        setConfirmExternal(true);
        return;
      }
      setConfirmExternal(false);
      setRestartError(null);
      const saved = await data.onSaveBasic(confirmed);
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
    },
    [data.basicSettings?.host, data.onSaveBasic],
  );

  if (!data.expanded) {
    return (
      <NodeBar
        icon={<SlidersHorizontal size={16} />}
        accent="var(--accent-model)"
        title="设置"
        subtitle={`${data.basicSettings?.theme === "dark" ? "暗色" : "亮色"} · 基础与模型`}
        expanded={false}
        onToggle={data.onToggleExpanded}
        buttonProps={
          {
            "data-model-setup-target": "settings",
          } as React.ButtonHTMLAttributes<HTMLButtonElement>
        }
      />
    );
  }

  return (
    <section className="settings-node">
      <NodeBar
        icon={<SlidersHorizontal size={16} />}
        expandedIcon={<Settings size={16} />}
        accent="var(--accent-model)"
        title="设置"
        expandedTitle="设置工作台"
        expandedSubtitle="基础设置与 Pi 模型"
        expanded={true}
        onToggle={data.onToggleExpanded}
      />
      <nav
        className="settings-node__tabs nodrag"
        role="tablist"
        aria-label="设置页面"
      >
        <button
          type="button"
          role="tab"
          aria-selected={data.page === "basic"}
          className={data.page === "basic" ? "active" : ""}
          onClick={data.onOpenBasic}
        >
          <Settings size={14} /> 基础设置
        </button>
        <button
          type="button"
          role="tab"
          data-model-setup-target="models"
          aria-selected={data.page === "models"}
          className={data.page === "models" ? "active" : ""}
          onClick={data.onOpenModels}
        >
          <SlidersHorizontal size={14} /> 模型设置
        </button>
      </nav>
      <div
        className="settings-node__body nodrag nowheel"
        role="tabpanel"
        id="settings-panel"
        aria-label={data.page === "basic" ? "基础设置" : "模型设置"}
      >
        {restartError ? (
          <p className="settings-node__banner settings-node__banner--error">
            {restartError}
          </p>
        ) : null}
        {restarting ? (
          <p className="settings-node__banner settings-node__banner--info">
            服务正在重启，等待恢复…
          </p>
        ) : null}
        {data.page === "basic" ? (
          <BasicSettingsPanel
            settings={data.basicSettings}
            error={data.basicError}
            saving={data.savingBasic || restarting}
            savingTheme={data.savingTheme}
            onChange={data.onBasicChange}
            onThemeChange={(theme) => void data.onThemeChange(theme)}
            onSave={() => void saveBasic()}
          />
        ) : (
          <ModelSettingsPanel
            settings={data.modelSettings}
            models={data.models}
            rpcStatus={data.modelRpcStatus}
            error={data.modelError}
            saving={data.savingModels}
            terminalDisabled={data.terminalDisabled}
            terminalAccessRequired={data.terminalAccessRequired}
            terminalAccessAuthorized={data.terminalAccessAuthorized}
            terminalAccessBusy={data.terminalAccessBusy}
            terminalAccessError={data.terminalAccessError}
            piLoginSession={data.piLoginSession}
            piLoginBusy={data.piLoginBusy}
            piLoginError={data.piLoginError}
            needsOnboarding={data.needsModelOnboarding}
            draftComplete={data.modelDraftComplete}
            savedComplete={data.modelSavedComplete}
            onChange={data.onModelChange}
            onSave={() => void data.onSaveModels()}
            onAuthorizeTerminalAccess={data.onAuthorizeTerminalAccess}
            onStartPiLogin={data.onStartPiLogin}
            onClosePiLogin={data.onClosePiLogin}
            onReload={() => void data.onReloadModels()}
          />
        )}
      </div>

      {confirmExternal ? (
        <div className="settings-node__confirm" role="alertdialog">
          <div>
            <span className="settings-node__confirm-icon">
              <AlertTriangle size={22} />
            </span>
            <strong>确认监听所有网络接口？</strong>
            <p>
              当前 API 没有身份验证。使用 0.0.0.0
              后，同一网络中的设备可能访问项目数据和操作接口。
            </p>
            <span>
              <button type="button" onClick={() => setConfirmExternal(false)}>
                取消
              </button>
              <button type="button" onClick={() => void saveBasic(true)}>
                我了解风险，继续
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
