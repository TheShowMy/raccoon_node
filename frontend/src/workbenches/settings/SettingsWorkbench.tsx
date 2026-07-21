import { PixelButton } from "@pxlkit/ui-kit";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
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
import {
  type SettingsCategory,
  useSettingsWorkbenchStore,
} from "../../store/settingsWorkbenchStore";
import {
  ToolWorkbench,
  WorkbenchPane,
  WorkbenchTabs,
  WorkbenchToolbar,
} from "../shared/ToolWorkbench";
import { ModelSettingsContent } from "../models/ModelsWorkbench";

/** 设置使用紧凑响应式功能区；表单控件只存在于所属面板内部。 */
function Group({
  panelId,
  title,
  children,
}: {
  panelId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" data-settings-section={panelId}>
      <div className="workbench-section-heading">
        <span>{title}</span>
      </div>
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
    <Group panelId="settings-appearance" title="外观（本地偏好）">
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
        非关键气泡（错误与阻断始终可达）
      </label>
    </Group>
  );
}

function NetworkGroup({ settings }: { settings: AppSettings }) {
  const updateMutation = useMutation({
    mutationFn: (network_policy: NetworkPolicy) =>
      getApi().updateSettings({ network_policy }),
  });
  return (
    <Group panelId="settings-network" title="网络策略">
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
              disabled={updateMutation.isPending}
              onClick={() => updateMutation.mutate(policy)}
            >
              {NETWORK_POLICY_LABELS[policy]}
            </button>
          ),
        )}
      </div>
      <p className="dnode__meta">
        应用层策略，不构成 OS 级网络沙箱；包管理器脚本风险保持可见。
      </p>
    </Group>
  );
}

function DefaultTaskBudgetGroup({ settings }: { settings: AppSettings }) {
  const [draft, setDraft] = useState(String(settings.default_task_budget_usd));
  const value = Number(draft);
  const dirty =
    draft.trim() !== "" &&
    Number.isFinite(value) &&
    value !== settings.default_task_budget_usd;
  const updateMutation = useMutation({
    mutationFn: (default_task_budget_usd: number) =>
      getApi().updateSettings({ default_task_budget_usd }),
  });
  return (
    <Group panelId="settings-budget" title="默认任务预算">
      <div className="set-row">
        <label htmlFor="default-task-budget">默认值（USD）</label>
        <input
          id="default-task-budget"
          className="dnode__input set-row__input"
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <PixelButton
          size="sm"
          tone="green"
          variant="outline"
          disabled={!dirty || value <= 0 || updateMutation.isPending}
          onClick={() => updateMutation.mutate(value)}
        >
          保存
        </PixelButton>
      </div>
      <p className="dnode__meta">
        仅作为新需求确认时的默认值；可在确认节点覆盖，Run 启动后冻结。达到 80%
        只告警，不暂停、取消或换模。
      </p>
    </Group>
  );
}

function SecurityGroup({ settings }: { settings: AppSettings }) {
  const isLoopback =
    settings.listen_host === "127.0.0.1" ||
    settings.listen_host === "localhost";
  const [localMode, setLocalMode] = useState(isLoopback);
  const [port, setPort] = useState(String(settings.listen_port));
  const portNumber = Number(port);
  const desiredHost = localMode ? "127.0.0.1" : "0.0.0.0";
  const dirty =
    desiredHost !== settings.listen_host || portNumber !== settings.listen_port;
  const updateMutation = useMutation({
    mutationFn: () =>
      getApi().updateSettings({
        listen_host: desiredHost,
        listen_port: portNumber,
      }),
  });
  return (
    <Group panelId="settings-security" title="监听与安全">
      <div className="set-row" role="group" aria-label="监听地址">
        <span>监听</span>
        {[
          { value: true, label: "本地（仅本机）" },
          { value: false, label: "局域网" },
        ].map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className="chat-node__override-option"
            data-active={localMode === option.value || undefined}
            onClick={() => setLocalMode(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="set-row">
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
            !Number.isInteger(portNumber) ||
            portNumber <= 0 ||
            updateMutation.isPending
          }
          onClick={() => updateMutation.mutate()}
        >
          保存
        </PixelButton>
      </div>
      <p className="dnode__meta">
        {localMode
          ? "本地：启动 nonce + SameSite session。"
          : "局域网：REST、NDJSON 与 WebSocket 全部必须鉴权。"}
      </p>
    </Group>
  );
}

function DiagnosticsGroup() {
  const {
    data: info,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => getApi().getDiagnostics(),
  });
  return (
    <Group panelId="settings-diagnostics" title="数据诊断">
      {isLoading ? (
        <p className="dnode__meta">加载诊断信息…</p>
      ) : isError ? (
        <p className="dnode__meta">诊断加载失败</p>
      ) : info ? (
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
        <p className="dnode__meta">暂无诊断数据</p>
      )}
    </Group>
  );
}

function SettingsResult({ settings }: { settings: AppSettings }) {
  return (
    <p
      className="set-result"
      role="status"
      data-ok={settings.last_result?.ok ?? true}
    >
      {settings.last_result?.message ?? "尚无设置操作结果。"}
    </p>
  );
}

function SettingsRestartDock({ settings }: { settings: AppSettings }) {
  const [dismissed, setDismissed] = useState(false);
  const restartMutation = useMutation({
    mutationFn: () => getApi().restartSystem(),
  });
  if (settings.pending_restart.length === 0 || dismissed) return null;
  return (
    <section
      className="workbench-action-dock px-cut px-shadowed-sm"
      data-tone="red"
      data-action-kind="settings_restart"
      aria-label={`重启确认：${settings.pending_restart.join("、")}`}
    >
      <div className="workbench-action-dock__body">
        <strong>重启确认 · 系统</strong>
        <span>
          restart_required：{settings.pending_restart.join("、")}
          。设置已保存；需重启系统后生效。
        </span>
      </div>
      <div className="workbench-action-dock__actions">
        <PixelButton
          size="sm"
          tone="red"
          disabled={restartMutation.isPending}
          onClick={() => restartMutation.mutate()}
        >
          确认重启
        </PixelButton>
        <PixelButton
          size="sm"
          variant="outline"
          onClick={() => setDismissed(true)}
        >
          稍后
        </PixelButton>
      </div>
    </section>
  );
}

const CATEGORIES: { id: SettingsCategory; label: string }[] = [
  { id: "general", label: "通用" },
  { id: "models", label: "模型" },
  { id: "runtime_security", label: "运行与安全" },
  { id: "maintenance", label: "维护" },
];

export function SettingsWorkbench() {
  const settings = useDomainStore((state) => state.settings);
  const activeCategory = useSettingsWorkbenchStore(
    (state) => state.activeCategory,
  );
  if (!settings) {
    return (
      <p className="tool-empty-state" role="status">
        设置数据加载中…
      </p>
    );
  }
  const content = {
    general: <AppearanceGroup />,
    models: <ModelSettingsContent />,
    runtime_security: (
      <>
        <NetworkGroup settings={settings} />
        <SecurityGroup settings={settings} />
        <DefaultTaskBudgetGroup settings={settings} />
      </>
    ),
    maintenance: <DiagnosticsGroup />,
  }[activeCategory];
  const activeLabel =
    CATEGORIES.find((category) => category.id === activeCategory)?.label ??
    "设置";
  return (
    <ToolWorkbench className="settings-workbench" ariaLabel="设置工具页">
      <WorkbenchToolbar ariaLabel="设置工作台工具栏">
        <strong className="tool-workbench__title">设置</strong>
        <span className="tool-workbench__meta">
          修改保存在来源分类；需要重启的设置不会伪装为即时生效。
        </span>
        <WorkbenchTabs
          className="settings-workbench__compact-tabs"
          ariaLabel="设置分类"
          tabs={CATEGORIES}
          active={activeCategory}
          onChange={(value) =>
            useSettingsWorkbenchStore.getState().setActiveCategory(value)
          }
        />
      </WorkbenchToolbar>
      <WorkbenchPane
        paneId="settings-categories"
        label="分类"
        ariaLabel="设置分类导航"
        className="settings-workbench__categories"
      >
        <nav className="settings-category-list" aria-label="设置分类">
          {CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              data-active={activeCategory === category.id || undefined}
              onClick={() =>
                useSettingsWorkbenchStore
                  .getState()
                  .setActiveCategory(category.id)
              }
            >
              {category.label}
            </button>
          ))}
        </nav>
      </WorkbenchPane>
      <WorkbenchPane
        paneId={`settings-content:${activeCategory}`}
        label={activeLabel}
        ariaLabel={`${activeLabel}设置`}
        className="settings-workbench__content"
      >
        {content}
        <SettingsResult settings={settings} />
        <SettingsRestartDock settings={settings} />
      </WorkbenchPane>
    </ToolWorkbench>
  );
}
