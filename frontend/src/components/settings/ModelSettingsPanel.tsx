import { useMemo, useState } from "react";
import type {
  ModelSettings,
  ModelTierKey,
  ModelTierSetting,
  PiModel,
  ThinkingLevel,
} from "../../types/api";
import {
  modelStatusText,
  thinkingLevels,
  tierLabels,
} from "../../utils/format";
import SimpleSelect from "../ui/SimpleSelect";

const TIERS: ModelTierKey[] = ["low", "medium", "high"];

export default function ModelSettingsPanel({
  settings,
  models,
  rpcStatus,
  error,
  saving,
  terminalDisabled,
  onChange,
  onSave,
  onLogin,
  onReload,
}: {
  settings: ModelSettings;
  models: PiModel[];
  rpcStatus: "idle" | "loading" | "ready" | "reconnecting" | "error";
  error: string | null;
  saving: boolean;
  terminalDisabled: boolean;
  onChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
  onSave: () => void;
  onLogin: () => void;
  onReload: () => void;
}) {
  const [selectedTier, setSelectedTier] = useState<ModelTierKey>("medium");
  const setting = settings[selectedTier];
  const disabled = rpcStatus !== "ready" || models.length === 0;
  const modelOptions = useMemo(
    () => [
      { value: "", label: "选择模型" },
      ...models.map((model) => ({
        value: model.id,
        label: `${model.provider}/${model.name}`,
      })),
    ],
    [models],
  );
  const thinkingOptions = thinkingLevels.map((level) => ({
    value: level.value,
    label: level.label,
  }));

  return (
    <div className="model-settings">
      <div className="model-status">
        <div>
          <span
            className={`model-status__dot model-status__dot--${rpcStatus}`}
          />
          <strong>{modelStatusText(rpcStatus)}</strong>
          <small>{models.length} 个可用模型</small>
        </div>
        <div>
          <button type="button" disabled={terminalDisabled} onClick={onLogin}>
            打开 Pi 登录终端
          </button>
          <button
            type="button"
            disabled={rpcStatus === "reconnecting"}
            onClick={onReload}
          >
            {rpcStatus === "reconnecting" ? "重载中…" : "重载 Pi 模型"}
          </button>
        </div>
      </div>
      {terminalDisabled ? (
        <p className="settings-drawer__notice">
          当前监听地址不允许 Web 终端。请先改为 127.0.0.1。
        </p>
      ) : (
        <p className="settings-drawer__notice">
          登录终端打开后请输入 /login。Raccoon 不读取或修改 Pi 的认证文件与
          models.json。
        </p>
      )}
      {error ? <p className="form-error">{error}</p> : null}

      <div className="model-settings__layout">
        <nav aria-label="模型档位">
          {TIERS.map((tier) => (
            <button
              type="button"
              className={selectedTier === tier ? "active" : ""}
              key={tier}
              onClick={() => setSelectedTier(tier)}
            >
              <strong>{tierLabels[tier]}档</strong>
              <small>
                {settings[tier].model_id
                  ? (models.find(
                      (model) => model.id === settings[tier].model_id,
                    )?.name ?? settings[tier].model_id)
                  : "未选择"}
              </small>
            </button>
          ))}
        </nav>
        <section>
          <h3>{tierLabels[selectedTier]}档模型</h3>
          <p>用于对应复杂度的 Agent 任务。</p>
          <label className="settings-field">
            <span>模型</span>
            <SimpleSelect
              value={setting.model_id ?? ""}
              options={modelOptions}
              disabled={disabled}
              placeholder="选择模型"
              onChange={(value) =>
                onChange(selectedTier, {
                  ...setting,
                  model_id: value || null,
                })
              }
            />
          </label>
          <label className="settings-field">
            <span>推理强度</span>
            <SimpleSelect
              value={setting.thinking_level}
              options={thinkingOptions}
              disabled={disabled}
              onChange={(value) =>
                onChange(selectedTier, {
                  ...setting,
                  thinking_level: value as ThinkingLevel,
                })
              }
            />
          </label>
        </section>
      </div>

      <div className="settings-drawer__footer">
        <button
          className="settings-primary"
          type="button"
          disabled={saving || disabled}
          onClick={onSave}
        >
          {saving ? "保存中…" : "保存模型设置"}
        </button>
      </div>
    </div>
  );
}
