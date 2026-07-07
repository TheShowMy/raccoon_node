import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
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
      <p className="settings-node__notice">{error ?? "正在读取基础设置…"}</p>
    );
  }

  const validPort =
    Number.isInteger(settings.port) &&
    settings.port >= 1 &&
    settings.port <= 65535;

  return (
    <Stack className="settings-form settings-form--astryx" gap={4}>
      {error ? (
        <Banner status="error" title="设置保存失败" description={error} />
      ) : null}

      <Stack className="settings-form__content" direction="horizontal" gap={4}>
        <Stack className="settings-form__column" gap={4}>
          <Card className="settings-section" padding={4}>
            <Stack gap={3}>
              <div className="settings-section__header">
                <h3>外观</h3>
                <p>点击后立即切换并保存。</p>
              </div>
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
            </Stack>
          </Card>

          <Card className="settings-section" padding={4}>
            <RadioList
              label="提交模式"
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
          </Card>
        </Stack>

        <Card
          className="settings-section settings-section--service"
          padding={4}
        >
          <Stack gap={4}>
            <div className="settings-section__header">
              <h3>服务监听</h3>
              <p>地址或端口修改后需要重启服务。</p>
            </div>
            <Stack direction="horizontal" gap={3} wrap="wrap">
              <Selector
                label="监听地址"
                width={220}
                value={settings.host}
                options={[
                  { value: "127.0.0.1", label: "127.0.0.1（仅本机）" },
                  { value: "0.0.0.0", label: "0.0.0.0（所有网络接口）" },
                ]}
                onChange={(host) => onChange({ ...settings, host })}
              />
              <TextInput
                label="端口"
                width={140}
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
            </Stack>
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
          </Stack>
        </Card>
      </Stack>

      <div className="settings-node__footer">
        <Button
          label="保存并按需重启"
          variant="primary"
          isLoading={saving}
          isDisabled={!validPort}
          onClick={onSave}
        />
      </div>
    </Stack>
  );
}
