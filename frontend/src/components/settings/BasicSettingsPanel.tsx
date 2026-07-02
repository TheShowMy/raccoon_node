import type { BasicSettings, CommitMode, ThemeMode } from "../../types/api";

const COMMIT_MODES: [CommitMode, string, string][] = [
  ["local", "本地提交", "完成任务后直接合并到当前分支"],
  ["pull_request", "PR / MR 合并", "通过远端平台创建合并请求"],
];

export default function BasicSettingsPanel({
  settings,
  error,
  saving,
  onChange,
  onSave,
}: {
  settings: BasicSettings | null;
  error: string | null;
  saving: boolean;
  onChange: (settings: BasicSettings) => void;
  onSave: () => void;
}) {
  if (!settings) {
    return (
      <p className="settings-drawer__notice">{error ?? "正在读取基础设置…"}</p>
    );
  }

  const validPort =
    Number.isInteger(settings.port) &&
    settings.port >= 1 &&
    settings.port <= 65535;

  return (
    <div className="settings-form">
      {error ? <p className="form-error">{error}</p> : null}

      <section className="settings-section">
        <div>
          <h3>外观</h3>
          <p>主题保存后立即应用。</p>
        </div>
        <div className="settings-segmented">
          {(
            [
              ["light", "亮色"],
              ["dark", "暗色"],
            ] as [ThemeMode, string][]
          ).map(([theme, label]) => (
            <button
              type="button"
              className={settings.theme === theme ? "active" : ""}
              key={theme}
              onClick={() => onChange({ ...settings, theme })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div>
          <h3>服务监听</h3>
          <p>地址或端口修改后需要重启服务。</p>
        </div>
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
            onChange={(event) =>
              onChange({ ...settings, port: Number(event.target.value) })
            }
          />
        </label>
        <div className="settings-effective">
          <strong>当前生效</strong>
          <code>
            {settings.effective_host}:{settings.effective_port}
          </code>
          {settings.host_overridden || settings.port_overridden ? (
            <p>
              当前值由 CLI 覆盖；保存值不会在重启后生效，除非移除对应的
              {settings.host_overridden ? " --host" : ""}
              {settings.port_overridden ? " --port" : ""} 参数。
            </p>
          ) : null}
        </div>
      </section>

      <section className="settings-section">
        <div>
          <h3>提交模式</h3>
          <p>保存后立即用于后续任务。</p>
        </div>
        <div className="settings-choice-list">
          {COMMIT_MODES.map(([mode, label, description]) => (
            <label key={mode}>
              <input
                type="radio"
                name="commit-mode"
                checked={settings.commit_mode === mode}
                onChange={() => onChange({ ...settings, commit_mode: mode })}
              />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </div>
      </section>

      <div className="settings-drawer__footer">
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
