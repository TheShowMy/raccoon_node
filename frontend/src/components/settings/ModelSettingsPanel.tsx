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
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { Toolbar } from "@astryxdesign/core/Toolbar";
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

const TIERS: ModelTierKey[] = ["low", "medium", "high"];

function rpcStatusVariant(
  status: "idle" | "loading" | "ready" | "reconnecting" | "error",
): "success" | "warning" | "error" | "accent" | "neutral" {
  if (status === "ready") return "success";
  if (status === "error") return "error";
  if (status === "loading" || status === "reconnecting") return "accent";
  return "neutral";
}

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

  async function authorizeTerminal(event: FormEvent<HTMLElement>) {
    event.preventDefault();
    const unlocked = await onAuthorizeTerminalAccess(accessKey);
    if (unlocked) {
      setAccessKey("");
    }
  }

  return (
    <Stack gap={3} height="fill">
      {needsOnboarding ? (
        <HStack as="ol" gap={2} aria-label="首次模型配置引导">
          {steps.map((step, index) => {
            const isCurrent = index === currentStep;
            const isDone = step.done;
            return (
              <li
                key={step.label}
                aria-current={isCurrent ? "step" : undefined}
              >
                <Token
                  label={step.label}
                  size="sm"
                  color={isDone ? "green" : isCurrent ? "blue" : "gray"}
                  icon={
                    isDone ? <Check size={12} strokeWidth={3} /> : undefined
                  }
                />
              </li>
            );
          })}
        </HStack>
      ) : null}

      <Grid columns={2} gap={4} align="stretch" height="fill">
        <Stack gap={3}>
          <Toolbar
            label="模型 RPC 状态"
            size="sm"
            variant="section"
            startContent={
              <HStack gap={2} align="center">
                <StatusDot
                  label={modelStatusText(rpcStatus)}
                  variant={rpcStatusVariant(rpcStatus)}
                  isPulsing={
                    rpcStatus === "loading" || rpcStatus === "reconnecting"
                  }
                />
                <Text type="label">{modelStatusText(rpcStatus)}</Text>
                <Text type="supporting" size="2xs">
                  {models.length} 个模型
                </Text>
              </HStack>
            }
            endContent={
              <Button
                label={rpcStatus === "reconnecting" ? "重载中…" : "重载模型"}
                variant="ghost"
                icon={<RefreshCw size={13} />}
                isDisabled={rpcStatus === "reconnecting"}
                onClick={onReload}
              />
            }
          />
          {error ? (
            <Section variant="muted" padding={3}>
              <Text type="supporting" color="accent">
                {error}
              </Text>
            </Section>
          ) : null}

          <Section padding={3}>
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
                      <Token
                        label={
                          thinkingLevels.find(
                            (level) =>
                              level.value === settings[tier].thinking_level,
                          )?.label ?? settings[tier].thinking_level
                        }
                        size="sm"
                        color="gray"
                      />
                    }
                  />
                );
              })}
            </RadioList>
          </Section>

          <Section padding={4}>
            <Stack gap={3}>
              <Stack gap={0.5}>
                <Text type="label" weight="semibold">
                  {tierLabels[selectedTier]}档模型
                </Text>
                <Text type="supporting" size="2xs">
                  用于对应复杂度的 Agent 任务。
                </Text>
              </Stack>
              <Grid columns={2} gap={3}>
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
              </Grid>
              <Toolbar
                label="保存模型设置"
                size="sm"
                variant="transparent"
                endContent={
                  <Button
                    label={saving ? "保存中…" : "保存模型设置"}
                    variant="primary"
                    isLoading={saving}
                    isDisabled={disabled}
                    onClick={onSave}
                  />
                }
              />
            </Stack>
          </Section>
        </Stack>

        <Section aria-label="Pi 登录终端" role="region" padding={0}>
          <Toolbar
            label="Pi 登录终端"
            size="sm"
            variant="transparent"
            startContent={
              <HStack gap={2} align="center">
                <Terminal size={14} />
                <Text type="label">Pi 登录终端</Text>
              </HStack>
            }
            endContent={
              piLoginSession ? (
                <>
                  <Button
                    label="重新启动"
                    variant="ghost"
                    icon={<RotateCw size={13} />}
                    isDisabled={piLoginBusy}
                    onClick={() => void onStartPiLogin()}
                  />
                  <Button
                    label="关闭"
                    variant="ghost"
                    icon={<Power size={13} />}
                    isDisabled={piLoginBusy}
                    onClick={() => void onClosePiLogin()}
                  />
                </>
              ) : (
                <Button
                  label={piLoginBusy ? "启动中…" : "启动终端"}
                  variant="secondary"
                  icon={<Terminal size={13} />}
                  isLoading={piLoginBusy}
                  isDisabled={terminalDisabled}
                  onClick={() => void onStartPiLogin()}
                />
              )
            }
          />
          {needsTerminalAccess ? (
            <HStack
              as="form"
              className="nodrag"
              gap={2}
              padding={3}
              align="center"
              onSubmit={(event) => void authorizeTerminal(event)}
            >
              <KeyRound size={16} />
              <TextInput
                label="终端密钥"
                value={accessKey}
                type="password"
                placeholder="输入启动密钥"
                onChange={setAccessKey}
              />
              <Button
                label="启用终端"
                type="submit"
                variant="primary"
                isLoading={terminalAccessBusy}
                isDisabled={!accessKey.trim()}
              />
              <Text type="supporting" size="2xs">
                {terminalAccessError ?? "验证通过后可启动 Pi 登录终端"}
              </Text>
            </HStack>
          ) : null}
          {piLoginSession ? (
            <TerminalSessionView
              projectId={piLoginSession.project_id}
              session={piLoginSession}
              fixedDark
            />
          ) : (
            <EmptyState
              title="连接 Pi 账号"
              description="启动终端后手动输入 /login，完成登录再点击“重载模型”。"
              icon={<Terminal size={28} />}
              isCompact
            />
          )}
          {terminalDisabled && !piLoginSession ? (
            <Stack padding={3} align="center">
              <Text type="supporting" size="2xs">
                Web 终端仅允许通过本机监听地址使用。
              </Text>
            </Stack>
          ) : null}
          {piLoginError ? (
            <Stack padding={3} align="center">
              <Text type="supporting" color="accent" size="2xs">
                {piLoginError}
              </Text>
            </Stack>
          ) : null}
        </Section>
      </Grid>
    </Stack>
  );
}
