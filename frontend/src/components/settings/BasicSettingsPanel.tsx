import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { Moon, Sun } from "lucide-react";
import { THEME_PACK_OPTIONS } from "../../theme/astryxThemes";
import type {
  BasicSettings,
  BasicSettingsUpdate,
  CommitMode,
  ThemePack,
} from "../../types/api";

const COMMIT_MODES: [CommitMode, string, string][] = [
  ["local", "本地提交", "完成任务后直接合并到当前分支"],
  ["pull_request", "PR / MR 合并", "通过远端平台创建合并请求"],
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
  onThemeChange: (
    update: Pick<BasicSettingsUpdate, "theme_pack" | "theme_mode">,
  ) => void;
  onSave: () => void;
}) {
  if (!settings) {
    return (
      <Section variant="muted">
        <Text type="supporting">{error ?? "正在读取基础设置…"}</Text>
      </Section>
    );
  }

  const validPort =
    Number.isInteger(settings.port) &&
    settings.port >= 1 &&
    settings.port <= 65535;

  return (
    <VStack gap={6}>
      {error ? (
        <Banner status="error" title="设置保存失败" description={error} />
      ) : null}

      <Section padding={4}>
        <VStack gap={4}>
          <Heading level={3}>外观</Heading>
          <Divider />
          <Stack gap={3}>
            <Selector
              label="主题包"
              value={settings.theme_pack}
              options={THEME_PACK_OPTIONS}
              isDisabled={savingTheme}
              onChange={(themePack) =>
                onThemeChange({ theme_pack: themePack as ThemePack })
              }
            />
            <SegmentedControl
              label="明暗模式"
              value={settings.theme_mode}
              onChange={(themeMode) =>
                onThemeChange({
                  theme_mode: themeMode === "light" ? "light" : "dark",
                })
              }
              isDisabled={savingTheme}
              layout="fill"
            >
              <SegmentedControlItem
                value="light"
                label="亮色"
                icon={<Sun size={14} />}
              />
              <SegmentedControlItem
                value="dark"
                label="暗色"
                icon={<Moon size={14} />}
              />
            </SegmentedControl>
          </Stack>
        </VStack>
      </Section>

      <Section padding={4}>
        <VStack gap={4}>
          <Heading level={3}>服务监听</Heading>
          <Divider />
          <VStack gap={4}>
            <Text type="supporting" size="2xs">
              地址或端口修改后需要重启服务。
            </Text>
            <HStack gap={3} align="start">
              <StackItem size="fill">
                <Selector
                  label="监听地址"
                  value={settings.host}
                  options={[
                    { value: "127.0.0.1", label: "127.0.0.1（仅本机）" },
                    { value: "0.0.0.0", label: "0.0.0.0（所有网络接口）" },
                  ]}
                  onChange={(host) => onChange({ ...settings, host })}
                />
              </StackItem>
              <StackItem size="fill">
                <TextInput
                  label="端口"
                  value={settings.port ? String(settings.port) : ""}
                  status={
                    validPort
                      ? undefined
                      : { type: "error", message: "端口必须是 1 到 65535" }
                  }
                  onChange={(value) => {
                    const port = value === "" ? 0 : Number(value);
                    onChange({
                      ...settings,
                      port: Number.isNaN(port) ? 0 : port,
                    });
                  }}
                />
              </StackItem>
            </HStack>
            <Section variant="muted" padding={3}>
              <Stack gap={2}>
                <HStack gap={2} align="center" wrap="wrap">
                  <Text type="label" size="sm">
                    当前生效
                  </Text>
                  <Text type="code" size="sm">
                    {settings.effective_host}:{settings.effective_port}
                  </Text>
                </HStack>
                {settings.host_overridden || settings.port_overridden ? (
                  <Text type="supporting" size="2xs">
                    当前值由 CLI 覆盖；保存值不会在重启后生效，除非移除对应的
                    {settings.host_overridden ? " --host" : ""}
                    {settings.port_overridden ? " --port" : ""} 参数。
                  </Text>
                ) : null}
              </Stack>
            </Section>
          </VStack>
        </VStack>
      </Section>

      <Section padding={4}>
        <VStack gap={4}>
          <Heading level={3}>提交模式</Heading>
          <Divider />
          <RadioList
            label="提交模式"
            isLabelHidden
            description="保存后用于后续任务。"
            value={settings.commit_mode}
            onChange={(mode) =>
              onChange({ ...settings, commit_mode: mode as CommitMode })
            }
          >
            {COMMIT_MODES.map(([mode, label, description]) => (
              <RadioListItem
                key={mode}
                value={mode}
                label={label}
                description={description}
              />
            ))}
          </RadioList>
        </VStack>
      </Section>

      <Toolbar
        label="保存基础设置"
        size="sm"
        variant="transparent"
        endContent={
          <Button
            label="保存并按需重启"
            variant="primary"
            isLoading={saving}
            isDisabled={!validPort}
            onClick={onSave}
          />
        }
      />
    </VStack>
  );
}
