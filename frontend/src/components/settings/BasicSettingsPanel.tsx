import { Moon, Sun, type LucideIcon } from "lucide-react";
import type { BasicSettings, CommitMode, ThemeMode } from "../../types/api";

const COMMIT_MODES: [CommitMode, string, string][] = [
  ["local", "本地提交", "完成任务后直接合并到当前分支"],
  ["pull_request", "PR / MR 合并", "通过远端平台创建合并请求"],
];

const THEMES: [ThemeMode, string, LucideIcon][] = [
  ["light", "亮色", Sun],
  ["dark", "暗色", Moon],
];

export default function BasicSettingsPanel({
  settings,
  error,
  saving,
  savingTheme,
  onChange,
  onThemeChange,
  onSave,
}: {
  settings: BasicSettings | null;
  error: string | null;
  saving: boolean;
  savingTheme: boolean;
  onChange: (settings: BasicSettings) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onSave: () => void;
}) {
  if (!settings) {
    return (
      <p className="settings-node__notice">{error ?? "正在读取基础设置…"}</p>
    );
  }

  const validPort =
    Number.isInteger(settings.port) &&
    settings.port >= 1 &&
    settings.port <= 65535;

  return (
    <div className="settings-form">
      {error ? (
        <p className="settings-node__banner settings-node__banner--error">
          {error}
        </p>
      ) : null}

      <div className="settings-form__content">
        <div className="settings-form__column">
          <section className="settings-section">
            <div className="settings-section__header">
              <h3>外观</h3>
              <p>点击后立即切换并保存。</p>
            </div>
            <div
              className="settings-theme-grid"
              role="radiogroup"
              aria-label="主题"
            >
              {THEMES.map(([theme, label, Icon]) => {
                const active = settings.theme === theme;
                return (
                  <button
                    key={theme}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={savingTheme}
                    className={active ? "active" : ""}
                    onClick={() => onThemeChange(theme)}
                  >
                    <Icon size={20} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__header">
              <h3>提交模式</h3>
              <p>保存后用于后续任务。</p>
            </div>
            <div
              className="settings-choice-list"
              role="radiogroup"
              aria-label="提交模式"
            >
              {COMMIT_MODES.map(([mode, label, description]) => {
                const checked = settings.commit_mode === mode;
                return (
                  <label key={mode} className={checked ? "active" : ""}>
                    <input
                      type="radio"
                      name="commit-mode"
                      checked={checked}
                      onChange={() =>
                        onChange({ ...settings, commit_mode: mode })
                      }
                    />
                    <span className="settings-choice-list__indicator" />
                    <span className="settings-choice-list__content">
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        </div>

        <section className="settings-section settings-section--service">
          <div className="settings-section__header">
            <h3>服务监听</h3>
            <p>地址或端口修改后需要重启服务。</p>
          </div>
          <div className="settings-network-grid">
            <label className="settings-field">
              <span>监听地址</span>
              <select
                value={settings.host}
                onChange={(event) =>
                  onChange({ ...settings, host: event.target.value })
                }
              >
                <option value="127.0.0.1">127.0.0.1（仅本机）</option>
                <option value="0.0.0.0">0.0.0.0（所有网络接口）</option>
              </select>
            </label>
            <label className="settings-field">
              <span>端口</span>
              <input
                type="number"
                min="1"
                max="65535"
                step="1"
                value={settings.port || ""}
                aria-invalid={!validPort}
                onChange={(event) => {
                  const value = event.target.value;
                  const port = value === "" ? 0 : Number(value);
                  onChange({
                    ...settings,
                    port: Number.isNaN(port) ? 0 : port,
                  });
                }}
              />
            </label>
            <div className="settings-effective">
              <span className="settings-effective__label">
                当前生效
                <code>
                  {settings.effective_host}:{settings.effective_port}
                </code>
              </span>
              {settings.host_overridden || settings.port_overridden ? (
                <p className="settings-effective__hint">
                  当前值由 CLI 覆盖；保存值不会在重启后生效，除非移除对应的
                  {settings.host_overridden ? " --host" : ""}
                  {settings.port_overridden ? " --port" : ""} 参数。
                </p>
              ) : null}
            </div>
          </div>
        </section>
      </div>

      <div className="settings-node__footer">
        <button
          className="settings-primary"
          type="button"
          disabled={saving || !validPort}
          onClick={onSave}
        >
          {saving ? "保存中…" : "保存并按需重启"}
        </button>
      </div>
    </div>
  );
}
