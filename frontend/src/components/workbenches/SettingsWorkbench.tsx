import { useCallback, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { restartApplication } from "../../api/client";
import type { SettingsPage } from "../../types/api";
import type { SettingsWorkbenchModel } from "../../types/viewModels";
import { readError } from "../../utils/format";
import BasicSettingsPanel from "../settings/BasicSettingsPanel";
import ModelSettingsPanel from "../settings/ModelSettingsPanel";
import SettingsLayout from "../settings/SettingsLayout";

async function waitForService(nextUrl: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(nextUrl, { mode: "no-cors", cache: "no-store" });
      return;
    } catch {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
  }
  throw new Error("服务未在预期时间内恢复");
}

export default function SettingsWorkbench({
  data,
}: {
  data: SettingsWorkbenchModel;
}) {
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

  const handlePageChange = useCallback(
    (page: SettingsPage) => {
      if (page === "basic") data.onOpenBasic();
      if (page === "models") data.onOpenModels();
    },
    [data.onOpenBasic, data.onOpenModels],
  );

  const banners = (
    <>
      {restartError ? (
        <Banner status="error" title="重启失败" description={restartError} />
      ) : null}
      {restarting ? (
        <Banner status="info" title="服务正在重启" description="等待恢复…" />
      ) : null}
    </>
  );

  return (
    <>
      <SettingsLayout
        page={data.page}
        onChangePage={handlePageChange}
        basicPanel={
          <BasicSettingsPanel
            settings={data.basicSettings}
            error={data.basicError}
            saving={data.savingBasic || restarting}
            savingTheme={data.savingTheme}
            onChange={data.onBasicChange}
            onThemeChange={(update) => void data.onThemeChange(update)}
            onSave={() => void saveBasic()}
          />
        }
        modelsPanel={
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
        }
        banners={banners}
      />
      <AlertDialog
        isOpen={confirmExternal}
        onOpenChange={setConfirmExternal}
        title="确认监听所有网络接口？"
        description="当前 API 没有身份验证。使用 0.0.0.0 后，同一网络中的设备可能访问项目数据和操作接口。"
        cancelLabel="取消"
        actionLabel="我了解风险，继续"
        actionVariant="destructive"
        onAction={() => void saveBasic(true)}
      />
    </>
  );
}
