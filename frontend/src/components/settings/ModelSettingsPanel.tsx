import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Terminal,
} from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
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
import TerminalAccessForm from "../terminal/TerminalAccessForm";
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
  const [showTerminal, setShowTerminal] = useState(false);
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

  if (showTerminal) {
    return (
      <VStack gap={6} height="100%">
        <Toolbar
          label="返回模型设置"
          size="sm"
          variant="transparent"
          startContent={
            <Button
              label="返回模型设置"
              variant="ghost"
              size="sm"
              icon={<ArrowLeft size={14} />}
              onClick={() => setShowTerminal(false)}
            />
          }
        />
        <Banner
          status="info"
          title="添加模型"
          description="启动终端后输入 /login 登录 Pi，然后执行 /reload 重载模型列表。完成后关闭终端即可返回模型设置。"
          container="section"
        />
        <StackItem size="fill">
          <Section
            aria-label="Pi 登录终端"
            role="region"
            padding={0}
            height="100%"
          >
            <VStack height="100%" gap={0}>
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
                <VStack padding={3} align="center">
                  <TerminalAccessForm
                    accessKey={accessKey}
                    accessError={terminalAccessError}
                    accessBusy={terminalAccessBusy}
                    helperText="验证通过后可启动 Pi 登录终端"
                    onChange={setAccessKey}
                    onSubmit={(event) => void authorizeTerminal(event)}
                  />
                </VStack>
              ) : null}
              <StackItem size="fill">
                {piLoginSession ? (
                  <TerminalSessionView session={piLoginSession} fixedDark />
                ) : (
                  <EmptyState
                    title="连接 Pi 账号"
                    description="启动终端后手动输入 /login，完成登录再点击“重载模型”。"
                    icon={<Terminal size={28} />}
                  />
                )}
              </StackItem>
              {terminalDisabled && !piLoginSession ? (
                <Banner
                  className="nodrag"
                  status="warning"
                  title="终端当前不可用"
                  description="Web 终端仅允许通过本机监听地址使用。"
                />
              ) : null}
              {piLoginError ? (
                <Stack padding={3} align="center">
                  <Text type="supporting" color="accent" size="2xs">
                    {piLoginError}
                  </Text>
                </Stack>
              ) : null}
            </VStack>
          </Section>
        </StackItem>
      </VStack>
    );
  }

  const selectedModelName = settings[selectedTier].model_id
    ? (models.find((model) => model.id === settings[selectedTier].model_id)
        ?.name ?? settings[selectedTier].model_id)
    : "未选择";
  const selectedThinkingLabel =
    thinkingLevels.find(
      (level) => level.value === settings[selectedTier].thinking_level,
    )?.label ?? settings[selectedTier].thinking_level;

  return (
    <VStack gap={6}>
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

      <Section padding={4}>
        <VStack gap={4}>
          <Heading level={3}>模型 RPC 状态</Heading>
          <Divider />
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
        </VStack>
      </Section>

      <Section padding={4}>
        <VStack gap={4}>
          <Heading level={3}>模型档位配置</Heading>
          <Divider />
          <VStack gap={4}>
            <SegmentedControl
              label="模型档位"
              value={selectedTier}
              onChange={(value) => setSelectedTier(value as ModelTierKey)}
              layout="fill"
            >
              {TIERS.map((tier) => (
                <SegmentedControlItem
                  key={tier}
                  value={tier}
                  label={`${tierLabels[tier]}档`}
                />
              ))}
            </SegmentedControl>

            <HStack gap={2} align="center" wrap="wrap">
              <Text type="label" size="sm">
                当前选择
              </Text>
              <Token label={selectedModelName} size="sm" color="gray" />
              <Token label={selectedThinkingLabel} size="sm" color="gray" />
            </HStack>

            <HStack gap={3} align="start">
              <StackItem size="fill">
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
              </StackItem>
              <StackItem size="fill">
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
              </StackItem>
            </HStack>
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
          </VStack>
        </VStack>
      </Section>

      <Section padding={4}>
        <VStack gap={4}>
          <Heading level={3}>添加模型</Heading>
          <Divider />
          <VStack gap={3}>
            <Text type="supporting" size="2xs">
              如需使用 Pi 账号下的更多模型，可启动 Pi
              登录终端并手动登录后重载模型列表。
            </Text>
            <Button
              label="添加模型"
              variant="secondary"
              icon={<Plus size={14} />}
              onClick={() => setShowTerminal(true)}
            />
          </VStack>
        </VStack>
      </Section>
    </VStack>
  );
}
