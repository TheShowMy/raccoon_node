import { Settings } from "lucide-react";
import type { StartNodeData, ThemeMode } from "../../types/api";

export default function BasicSettingsNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "basic-settings" }>;
}) {
  const settings = data.settings;
  const validPort =
    settings !== null &&
    Number.isInteger(settings.port) &&
    settings.port >= 1 &&
    settings.port <= 65535;

  return (
    <>
      <div className="node-header node-header--model">
        <span className="node-icon">
          <Settings size={20} />
        </span>
        <div>
          <strong>基础设置</strong>
          <span>主题与服务端口</span>
        </div>
      </div>
      {data.error ? <p className="form-error">{data.error}</p> : null}
      {settings ? (
        <div className="basic-settings">
          <fieldset>
            <legend>主题</legend>
            {(
              [
                ["light", "亮色"],
                ["dark", "暗色"],
              ] as [ThemeMode, string][]
            ).map(([theme, label]) => (
              <label key={theme}>
                <input
                  type="radio"
                  name="theme"
                  value={theme}
                  checked={settings.theme === theme}
                  onChange={() => data.onChange({ ...settings, theme })}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <label className="basic-settings__port">
            <span>端口</span>
            <input
              type="number"
              min="1"
              max="65535"
              step="1"
              value={settings.port || ""}
              aria-invalid={!validPort}
              onChange={(event) =>
                data.onChange({
                  ...settings,
                  port: Number(event.target.value),
                })
              }
            />
            <small>下次启动生效</small>
            {settings.port_overridden ? (
              <small>当前端口由命令行参数覆盖；下次启动请勿传入 --port。</small>
            ) : null}
          </label>
        </div>
      ) : data.error ? null : (
        <p className="model-notice">正在读取基础设置…</p>
      )}
      <div className="model-actions">
        <button
          className="model-actions__close"
          type="button"
          disabled={data.saving}
          onClick={data.onClose}
        >
          关闭
        </button>
        <button
          className="model-actions__save"
          type="button"
          disabled={data.saving || !validPort}
          onClick={() => void data.onSave()}
        >
          {data.saving ? "保存中" : "保存"}
        </button>
      </div>
    </>
  );
}
