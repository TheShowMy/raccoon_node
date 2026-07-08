import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import {
  Check,
  KeyRound,
  Power,
  RefreshCw,
  RotateCw,
  Terminal,
} from "lucide-react";
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
import { Button } from "@astryxdesign/core/Button";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";

const TIERS: ModelTierKey[] = ["low", "medium", "high"];

export default function ModelSettingsPanel({
  settings,
  models,
  rpcStatus,
  error,
  saving,
  terminalDisabled,
  terminalAccessRequired,
  terminalAccessAuthorized,
  terminalAccessBusy,
  terminalAccessError,
  piLoginSession,
  piLoginBusy,
  piLoginError,
  needsOnboarding,
  draftComplete,
  savedComplete,
  onChange,
  onSave,
  onAuthorizeTerminalAccess,
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
  terminalAccessRequired: boolean;
  terminalAccessAuthorized: boolean;
  terminalAccessBusy: boolean;
  terminalAccessError: string | null;
  piLoginSession: TerminalSession | null;
  piLoginBusy: boolean;
  piLoginError: string | null;
  needsOnboarding: boolean;
  draftComplete: boolean;
  savedComplete: boolean;
  onChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
  onSave: () => void;
  onAuthorizeTerminalAccess: (key: string) => Promise<boolean>;
  onStartPiLogin: () => Promise<void>;
  onClosePiLogin: () => Promise<void>;
  onReload: () => void;
}) {
  const [selectedTier, setSelectedTier] = useState<ModelTierKey>("medium");
  const [accessKey, setAccessKey] = useState("");
  const setting = settings[selectedTier];
  const disabled = rpcStatus !== "ready" || models.length === 0;
  const needsTerminalAccess =
    terminalAccessRequired && !terminalAccessAuthorized;
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

  async function authorizeTerminal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const unlocked = await onAuthorizeTerminalAccess(accessKey);
    if (unlocked) {
      setAccessKey("");
    }
  }

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
            <Button
              label={rpcStatus === "reconnecting" ? "重载中…" : "重载模型"}
              size="sm"
              variant="ghost"
              icon={<RefreshCw size={13} />}
              isDisabled={rpcStatus === "reconnecting"}
              onClick={onReload}
            />
          </div>
          {error ? (
            <p className="settings-node__banner settings-node__banner--error">
              {error}
            </p>
          ) : null}

          <div className="model-tier-selector model-tier-selector--compact">
            <RadioList
              label="模型档位"
              isLabelHidden
              value={selectedTier}
              onChange={(value) => setSelectedTier(value as ModelTierKey)}
              orientation="horizontal"
              size="sm"
            >
              {TIERS.map((tier) => {
                const modelName = settings[tier].model_id
                  ? (models.find(
                      (model) => model.id === settings[tier].model_id,
                    )?.name ?? settings[tier].model_id)
                  : "未选择";
                return (
                  <RadioListItem
                    key={tier}
                    value={tier}
                    label={`${tierLabels[tier]}档`}
                    description={modelName}
                    endContent={
                      <span className="model-tier-card__thinking">
                        {thinkingLevels.find(
                          (level) =>
                            level.value === settings[tier].thinking_level,
                        )?.label ?? settings[tier].thinking_level}
                      </span>
                    }
                  />
                );
              })}
            </RadioList>
          </div>

          <div className="model-tier-detail">
            <div className="settings-section__header">
              <h3>{tierLabels[selectedTier]}档模型</h3>
              <p>用于对应复杂度的 Agent 任务。</p>
            </div>
            <div className="model-tier-detail__fields">
              <Selector
                label="模型"
                value={setting.model_id ?? ""}
                options={modelOptions}
                isDisabled={disabled}
                placeholder="选择模型"
                onChange={(value) =>
                  onChange(selectedTier, {
                    ...setting,
                    model_id: value || null,
                  })
                }
              />
              <Selector
                label="推理强度"
                value={setting.thinking_level}
                options={thinkingOptions}
                isDisabled={disabled}
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
            </div>
            <div className="model-tier-detail__actions">
              <Button
                label={saving ? "保存中…" : "保存模型设置"}
                variant="primary"
                isLoading={saving}
                isDisabled={disabled}
                onClick={onSave}
              />
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
                  <Button
                    label="重新启动"
                    size="sm"
                    variant="ghost"
                    icon={<RotateCw size={13} />}
                    isDisabled={piLoginBusy}
                    onClick={() => void onStartPiLogin()}
                  />
                  <Button
                    label="关闭"
                    size="sm"
                    variant="ghost"
                    icon={<Power size={13} />}
                    isDisabled={piLoginBusy}
                    onClick={() => void onClosePiLogin()}
                  />
                </>
              ) : (
                <Button
                  label={piLoginBusy ? "启动中…" : "启动终端"}
                  size="sm"
                  variant="secondary"
                  icon={<Terminal size={13} />}
                  isLoading={piLoginBusy}
                  isDisabled={terminalDisabled}
                  onClick={() => void onStartPiLogin()}
                />
              )}
            </div>
          </header>
          {needsTerminalAccess ? (
            <form
              className="terminal-node__access nodrag"
              onSubmit={(event) => void authorizeTerminal(event)}
            >
              <KeyRound size={16} />
              <TextInput
                label="终端密钥"
                value={accessKey}
                type="password"
                placeholder="TUI 中显示的本次启动密钥"
                onChange={setAccessKey}
              />
              <Button
                label="启用终端"
                type="submit"
                variant="primary"
                isLoading={terminalAccessBusy}
                isDisabled={!accessKey.trim()}
              />
              <small>
                {terminalAccessError ?? "验证通过后可启动 Pi 登录终端"}
              </small>
            </form>
          ) : null}
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
