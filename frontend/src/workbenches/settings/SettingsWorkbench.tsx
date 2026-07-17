import { useQuery } from "@tanstack/react-query";
import { PixelButton } from "@pxlkit/ui-kit";
import { useState } from "react";
import { getApi } from "../../api";
import { NETWORK_POLICY_LABELS } from "../../api/settings";
import type { AppSettings, NetworkPolicy } from "../../api/types";
import {
  useAppearanceStore,
  type DensityPreference,
  type ThemePreference,
} from "../../store/appearanceStore";
import { useDomainStore } from "../../store/domainStore";

/**
 * 设置工作台（FE-SET-001～003）：设置分组节点化卡片，常规布局
 * （表单密集型内容不强行画布化，02 §2.2）。外观为本地偏好即时生效。
 */

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="set-group px-cut px-shadowed-sm" aria-label={title}>
      <h3 className="px-font-pixel set-group__title">{title}</h3>
      {children}
    </section>
  );
}

function AppearanceGroup() {
  const theme = useAppearanceStore((state) => state.theme);
  const density = useAppearanceStore((state) => state.density);
  const petAnimation = useAppearanceStore((state) => state.petAnimation);
  const nonCriticalBubbles = useAppearanceStore(
    (state) => state.nonCriticalBubbles,
  );
  return (
    <Group title="外观（本地偏好）">
      <div className="set-row" role="group" aria-label="明暗模式">
        <span>明暗</span>
        {(["system", "light", "dark"] as ThemePreference[]).map((value) => (
          <button
            key={value}
            type="button"
            className="chat-node__override-option"
            data-active={theme === value || undefined}
            onClick={() => useAppearanceStore.getState().setTheme(value)}
          >
            {value === "system"
              ? "跟随系统"
              : value === "light"
                ? "浅色"
                : "深色"}
          </button>
        ))}
      </div>
      <div className="set-row" role="group" aria-label="密度">
        <span>密度</span>
        {(["comfortable", "compact"] as DensityPreference[]).map((value) => (
          <button
            key={value}
            type="button"
            className="chat-node__override-option"
            data-active={density === value || undefined}
            onClick={() => useAppearanceStore.getState().setDensity(value)}
          >
            {value === "comfortable" ? "舒适" : "紧凑"}
          </button>
        ))}
      </div>
      <label className="set-row set-row--check">
        <input
          type="checkbox"
          checked={petAnimation}
          onChange={(event) =>
            useAppearanceStore.getState().setPetAnimation(event.target.checked)
          }
        />
        GrayDango 动画（关闭后静态表现）
      </label>
      <label className="set-row set-row--check">
        <input
          type="checkbox"
          checked={nonCriticalBubbles}
          onChange={(event) =>
            useAppearanceStore
              .getState()
              .setNonCriticalBubbles(event.target.checked)
          }
        />
        非关键气泡（完成/信息；错误与阻断始终可达）
      </label>
    </Group>
  );
}

function NetworkGroup({ settings }: { settings: AppSettings }) {
  return (
    <Group title="网络策略">
      <div className="set-row" role="radiogroup" aria-label="网络策略">
        {(Object.keys(NETWORK_POLICY_LABELS) as NetworkPolicy[]).map(
          (policy) => (
            <button
              key={policy}
              type="button"
              role="radio"
              aria-checked={settings.network_policy === policy}
              className="chat-node__override-option"
              data-active={settings.network_policy === policy || undefined}
              onClick={() =>
                void useDomainStore
                  .getState()
                  .updateSettings({ network_policy: policy })
              }
            >
              {NETWORK_POLICY_LABELS[policy]}
            </button>
          ),
        )}
      </div>
      <p className="dnode__meta">
        应用层策略，不构成 OS 级网络沙箱；包管理器生命周期脚本风险可见。
      </p>
    </Group>
  );
}

function ThresholdGroup({ settings }: { settings: AppSettings }) {
  const [draft, setDraft] = useState(String(settings.soft_threshold_usd));
  const value = Number(draft);
  const dirty =
    draft.trim() !== "" &&
    Number.isFinite(value) &&
    value !== settings.soft_threshold_usd;
  return (
    <Group title="用量软阈值">
      <div className="set-row">
        <label htmlFor="soft-threshold">阈值（USD）</label>
        <input
          id="soft-threshold"
          className="dnode__input set-row__input"
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <PixelButton
          size="sm"
          tone="green"
          variant="outline"
          disabled={!dirty || value <= 0}
          onClick={() => {
            void useDomainStore
              .getState()
              .updateSettings({ soft_threshold_usd: value });
          }}
        >
          保存
        </PixelButton>
      </div>
      <p className="dnode__meta">软阈值只告警，不自动暂停、取消或换模。</p>
    </Group>
  );
}

function ListenGroup({ settings }: { settings: AppSettings }) {
  const [host, setHost] = useState(settings.listen_host);
  const [port, setPort] = useState(String(settings.listen_port));
  const portNumber = Number(port);
  const dirty =
    host !== settings.listen_host || portNumber !== settings.listen_port;
  return (
    <Group title="监听与端口">
      <div className="set-row">
        <label htmlFor="listen-host">Host</label>
        <input
          id="listen-host"
          className="dnode__input set-row__input"
          value={host}
          onChange={(event) => setHost(event.target.value)}
        />
        <label htmlFor="listen-port">端口</label>
        <input
          id="listen-port"
          className="dnode__input set-row__input set-row__input--narrow"
          inputMode="numeric"
          value={port}
          onChange={(event) => setPort(event.target.value)}
        />
        <PixelButton
          size="sm"
          tone="green"
          variant="outline"
          disabled={
            !dirty ||
            !host.trim() ||
            !Number.isInteger(portNumber) ||
            portNumber <= 0
          }
          onClick={() => {
            void useDomainStore.getState().updateSettings({
              listen_host: host.trim(),
              listen_port: portNumber,
            });
          }}
        >
          保存
        </PixelButton>
      </div>
      {settings.pending_restart.length > 0 ? (
        <div className="set-result set-result--restart" role="status">
          <p>
            <strong>restart_required</strong>：
            {settings.pending_restart.join("、")}{" "}
            已保存，需重启后生效（保存和重启是两个动作）。
          </p>
          <PixelButton
            size="sm"
            tone="red"
            variant="outline"
            onClick={() => void useDomainStore.getState().restartSystem()}
          >
            立即模拟重启
          </PixelButton>
        </div>
      ) : null}
    </Group>
  );
}

function DiagnosticsGroup() {
  const diagnosticsQuery = useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => getApi().getDiagnostics(),
  });
  const info = diagnosticsQuery.data;
  return (
    <Group title="数据诊断">
      {info ? (
        <>
          <p className="dnode__text">{info.event_store_health}</p>
          <p className="dnode__meta">last_sequence：{info.last_sequence}</p>
          <ul className="dnode__lines" aria-label="备份列表">
            {info.backups.map((backup) => (
              <li key={backup} className="px-font-mono">
                {backup}
              </li>
            ))}
          </ul>
          <p className="dnode__meta">{info.archive_hint}</p>
        </>
      ) : (
        <p className="dnode__meta">加载诊断信息…</p>
      )}
    </Group>
  );
}

function SettingsResult({ settings }: { settings: AppSettings }) {
  if (!settings.last_result) return null;
  return (
    <p className="set-result" role="status" data-ok={settings.last_result.ok}>
      {settings.last_result.message}
    </p>
  );
}

export function SettingsWorkbench() {
  const settings = useDomainStore((state) => state.settings);
  if (!settings) return null;
  return (
    <div className="settings-workbench nodrag nowheel">
      <AppearanceGroup />
      <NetworkGroup settings={settings} />
      <ThresholdGroup settings={settings} />
      <ListenGroup settings={settings} />
      <DiagnosticsGroup />
      <SettingsResult settings={settings} />
    </div>
  );
}
