import { useMemo, useState } from "react";
import { Check, Power, RefreshCw, RotateCw, Terminal } from "lucide-react";
import type {
  ModelSettings,
  ModelTierKey,
  ModelTierSetting,
  PiModel,
  TerminalSession,
  ThinkingLevel,
} from "../../types/api";
import {
  modelStatusText,
  thinkingLevels,
  tierLabels,
} from "../../utils/format";
import TerminalSessionView from "../terminal/TerminalSessionView";
import SimpleSelect from "../ui/SimpleSelect";

const TIERS: ModelTierKey[] = ["low", "medium", "high"];

export default function ModelSettingsPanel({
  settings,
  models,
  rpcStatus,
  error,
  saving,
  terminalDisabled,
  piLoginSession,
  piLoginBusy,
  piLoginError,
  needsOnboarding,
  draftComplete,
  savedComplete,
  onChange,
  onSave,
  onStartPiLogin,
  onClosePiLogin,
  onReload,
}: {
  settings: ModelSettings;
  models: PiModel[];
  rpcStatus: "idle" | "loading" | "ready" | "reconnecting" | "error";
  error: string | null;
  saving: boolean;
  terminalDisabled: boolean;
  piLoginSession: TerminalSession | null;
  piLoginBusy: boolean;
  piLoginError: string | null;
  needsOnboarding: boolean;
  draftComplete: boolean;
  savedComplete: boolean;
  onChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
  onSave: () => void;
  onStartPiLogin: () => Promise<void>;
  onClosePiLogin: () => Promise<void>;
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
  const thinkingOptions: { value: ThinkingLevel; label: string }[] =
    thinkingLevels.map((level) => ({
      value: level.value,
      label: level.label,
    }));
  const modelsReady = models.length > 0;
  const steps = [
    { label: "启动终端", done: Boolean(piLoginSession) },
    { label: "输入 /login", done: modelsReady },
    { label: "重载模型", done: modelsReady },
    { label: "配置三档", done: draftComplete },
    { label: "保存", done: savedComplete },
  ];
  const currentStep = steps.findIndex((step) => !step.done);

  return (
    <div
      className={`model-settings ${
        needsOnboarding ? "model-settings--guided" : ""
      }`}
    >
      {needsOnboarding ? (
        <ol className="model-onboarding" aria-label="首次模型配置引导">
          {steps.map((step, index) => {
            const isCurrent = index === currentStep;
            const isDone = step.done;
            return (
              <li
                className={[
                  isDone ? "is-done" : "",
                  isCurrent ? "is-current" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={step.label}
                aria-current={isCurrent ? "step" : undefined}
              >
                <span>
                  {isDone ? <Check size={12} strokeWidth={3} /> : index + 1}
                </span>
                <small>{step.label}</small>
              </li>
            );
          })}
        </ol>
      ) : null}

      <div className="model-settings__workspace">
        <section className="model-settings__config">
          <div className="model-status">
            <div>
              <span
                className={`model-status__dot model-status__dot--${rpcStatus}`}
              />
              <strong>{modelStatusText(rpcStatus)}</strong>
              <small>{models.length} 个模型</small>
            </div>
            <button
              type="button"
              disabled={rpcStatus === "reconnecting"}
              onClick={onReload}
            >
              <RefreshCw size={13} />
              {rpcStatus === "reconnecting" ? "重载中…" : "重载模型"}
            </button>
          </div>
          {error ? (
            <p className="settings-node__banner settings-node__banner--error">
              {error}
            </p>
          ) : null}

          <div
            className="model-tier-selector model-tier-selector--compact"
            role="radiogroup"
            aria-label="模型档位"
          >
            {TIERS.map((tier) => {
              const active = selectedTier === tier;
              const modelName = settings[tier].model_id
                ? (models.find((model) => model.id === settings[tier].model_id)
                    ?.name ?? settings[tier].model_id)
                : "未选择";
              return (
                <button
                  key={tier}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={active ? "active" : ""}
                  onClick={() => setSelectedTier(tier)}
                >
                  <span className="model-tier-card__row">
                    <strong>{tierLabels[tier]}档</strong>
                    <span className="model-tier-card__thinking">
                      {thinkingLevels.find(
                        (level) =>
                          level.value === settings[tier].thinking_level,
                      )?.label ?? settings[tier].thinking_level}
                    </span>
                  </span>
                  <span className="model-tier-card__model">{modelName}</span>
                </button>
              );
            })}
          </div>

          <div className="model-tier-detail">
            <div className="settings-section__header">
              <h3>{tierLabels[selectedTier]}档模型</h3>
              <p>用于对应复杂度的 Agent 任务。</p>
            </div>
            <div className="model-tier-detail__fields">
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
                  onChange={(value) => {
                    const level = thinkingLevels.find(
                      (level) => level.value === value,
                    )?.value;
                    onChange(selectedTier, {
                      ...setting,
                      thinking_level: level ?? setting.thinking_level,
                    });
                  }}
                />
              </label>
            </div>
            <div className="model-tier-detail__actions">
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
        </section>

        <section className="pi-login-terminal" aria-label="Pi 登录终端">
          <header>
            <span>
              <Terminal size={14} />
              <strong>Pi 登录终端</strong>
            </span>
            <div>
              {piLoginSession ? (
                <>
                  <button
                    type="button"
                    disabled={piLoginBusy}
                    onClick={() => void onStartPiLogin()}
                  >
                    <RotateCw size={13} /> 重新启动
                  </button>
                  <button
                    type="button"
                    disabled={piLoginBusy}
                    onClick={() => void onClosePiLogin()}
                  >
                    <Power size={13} /> 关闭
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={piLoginBusy || terminalDisabled}
                  onClick={() => void onStartPiLogin()}
                >
                  <Terminal size={13} />
                  {piLoginBusy ? "启动中…" : "启动终端"}
                </button>
              )}
            </div>
          </header>
          {piLoginSession ? (
            <TerminalSessionView
              projectId={piLoginSession.project_id}
              session={piLoginSession}
              fixedDark
            />
          ) : (
            <div className="pi-login-terminal__empty">
              <Terminal size={28} />
              <strong>连接 Pi 账号</strong>
              <p>
                启动终端后手动输入 <code>/login</code>
                ，完成登录再点击“重载模型”。
              </p>
              {terminalDisabled ? (
                <small>Web 终端仅允许通过本机监听地址使用。</small>
              ) : null}
            </div>
          )}
          {piLoginError ? (
            <p className="pi-login-terminal__error">{piLoginError}</p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
