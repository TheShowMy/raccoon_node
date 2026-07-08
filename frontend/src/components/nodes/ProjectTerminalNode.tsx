import {
  AlertTriangle,
  KeyRound,
  Plus,
  Settings2,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import type {
  StartNodeData,
  TerminalCommandProfileDraft,
} from "../../types/api";
import TerminalSessionView from "../terminal/TerminalSessionView";
import NodeBar from "../ui/NodeBar";

type TerminalData = Extract<StartNodeData, { kind: "project-terminal" }>;

function useDisabledReason(disabled: boolean, reason?: string): string | null {
  return useMemo(() => {
    if (!disabled) return null;
    if (reason === "terminal-authorization-required") {
      return "监听 0.0.0.0 时需要输入本次启动的终端密钥";
    }
    if (reason === "non-localhost-access") {
      const hostname =
        typeof window !== "undefined" ? window.location.hostname : "";
      return `终端仅在使用 localhost / 127.0.0.1 访问时可用（当前为 ${hostname}）`;
    }
    return "终端当前不可用";
  }, [disabled, reason]);
}

export default function ProjectTerminalNode({ data }: { data: TerminalData }) {
  const [editingProfiles, setEditingProfiles] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [draftProfiles, setDraftProfiles] = useState<
    TerminalCommandProfileDraft[]
  >([]);
  const activeSession = useMemo(
    () =>
      data.sessions.find((session) => session.id === data.activeSessionId) ??
      null,
    [data.activeSessionId, data.sessions],
  );
  const hasSessions = data.sessions.length > 0;
  const disabledReason = useDisabledReason(
    data.terminalDisabled,
    data.terminalDisabledReason,
  );
  const needsTerminalAccess =
    data.terminalAccessRequired && !data.terminalAccessAuthorized;

  function openProfileEditor() {
    setDraftProfiles(
      data.commandProfiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        command: profile.command,
      })),
    );
    setEditingProfiles(true);
  }

  async function saveProfiles() {
    await data.onSaveCommandProfiles(
      draftProfiles.filter(
        (profile) => profile.name.trim() && profile.command.trim(),
      ),
    );
    setEditingProfiles(false);
  }

  async function authorizeTerminal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const unlocked = await data.onAuthorizeTerminalAccess(accessKey);
    if (unlocked) {
      setAccessKey("");
    }
  }

  return (
    <section
      className={`terminal-node ${data.collapsed ? "terminal-node--collapsed" : ""}`}
    >
      {data.collapsed ? (
        <NodeBar
          icon={<Terminal size={16} />}
          accent="var(--accent-projects)"
          title="项目终端"
          subtitle={
            hasSessions
              ? `${data.sessions.length} 个终端 · ${activeSession?.title ?? "未选择"}`
              : "默认在项目根目录启动"
          }
          expanded={false}
          onToggle={data.onToggleCollapsed}
          extras={
            data.error ? (
              <Token label={data.error} color="red" size="sm" />
            ) : null
          }
        />
      ) : (
        <Stack className="terminal-node__body" gap={0}>
          <NodeBar
            icon={<Terminal size={16} />}
            accent="var(--accent-projects)"
            title="项目终端"
            expanded={true}
            onToggle={data.onToggleCollapsed}
            actions={
              <>
                {data.error ? (
                  <Token label={data.error} color="red" size="sm" />
                ) : null}
                <IconButton
                  label="新建"
                  tooltip="新建终端"
                  icon={<Plus size={14} />}
                  variant="ghost"
                  isDisabled={data.busy || data.terminalDisabled}
                  onClick={() => void data.onCreateTerminal()}
                />
              </>
            }
          />

          {disabledReason ? (
            <Banner
              className="terminal-node__notice nodrag"
              status="warning"
              title={disabledReason}
              icon={<AlertTriangle size={14} />}
            />
          ) : null}
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
                isLoading={data.terminalAccessBusy}
                isDisabled={!accessKey.trim()}
              />
              <small>
                {data.terminalAccessError ?? "验证通过后 12 小时内无需再次输入"}
              </small>
            </form>
          ) : data.terminalAccessRequired && data.terminalAccessExpiresAt ? (
            <Stack
              className="terminal-node__access-status nodrag"
              direction="horizontal"
              gap={2}
              align="center"
            >
              <KeyRound size={14} />
              <Text type="supporting" size="2xs">
                终端已授权至{" "}
                {new Date(data.terminalAccessExpiresAt).toLocaleTimeString()}
              </Text>
            </Stack>
          ) : null}

          <Toolbar
            label="终端命令"
            className="terminal-node__toolbar nodrag"
            size="sm"
            variant="transparent"
            startContent={
              <Stack
                className="terminal-node__command-list"
                direction="horizontal"
                gap={1}
                wrap="wrap"
              >
                {data.commandProfiles.map((profile) => (
                  <Button
                    key={profile.id}
                    label={profile.name}
                    variant="secondary"
                    icon={<Terminal size={10} />}
                    isDisabled={data.busy || data.terminalDisabled}
                    className="terminal-node__command-tag"
                    onClick={() =>
                      void data.onCreateTerminal(profile.command, profile.name)
                    }
                  />
                ))}
                {data.commandProfiles.length === 0 ? (
                  <Text
                    className="terminal-node__command-hint"
                    type="supporting"
                    size="2xs"
                  >
                    暂无自定义启动命令
                  </Text>
                ) : null}
              </Stack>
            }
            endContent={
              <Button
                label="管理命令"
                variant="ghost"
                icon={<Settings2 size={13} />}
                className="terminal-node__manage"
                onClick={openProfileEditor}
              />
            }
          />

          {editingProfiles ? (
            <Section className="terminal-node__profiles nodrag" padding={3}>
              <Toolbar
                label="自定义启动命令"
                className="terminal-node__profiles-head"
                size="sm"
                variant="transparent"
                startContent={<Text type="label">自定义启动命令</Text>}
                endContent={
                  <IconButton
                    label="关闭"
                    tooltip="关闭"
                    icon={<X size={14} />}
                    variant="ghost"
                    onClick={() => setEditingProfiles(false)}
                  />
                }
              />
              <Stack gap={2}>
                {draftProfiles.map((profile, index) => (
                  <Stack
                    key={profile.id ?? index}
                    className="terminal-node__profile-row"
                    direction="horizontal"
                    gap={2}
                    align="center"
                  >
                    <TextInput
                      label="名称"
                      isLabelHidden
                      width={140}
                      value={profile.name}
                      placeholder="名称"
                      onChange={(value) =>
                        setDraftProfiles((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, name: value }
                              : item,
                          ),
                        )
                      }
                    />
                    <TextInput
                      label="命令"
                      isLabelHidden
                      width="100%"
                      value={profile.command}
                      placeholder="命令，例如 npm run dev"
                      onChange={(value) =>
                        setDraftProfiles((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, command: value }
                              : item,
                          ),
                        )
                      }
                    />
                    <IconButton
                      label="删除命令"
                      tooltip="删除命令"
                      icon={<Trash2 size={13} />}
                      variant="ghost"
                      onClick={() =>
                        setDraftProfiles((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                    />
                  </Stack>
                ))}
                <Toolbar
                  label="命令编辑操作"
                  className="terminal-node__profiles-actions"
                  size="sm"
                  variant="transparent"
                  endContent={
                    <>
                      <Button
                        label="添加命令"
                        variant="secondary"
                        onClick={() =>
                          setDraftProfiles((current) => [
                            ...current,
                            { name: "", command: "" },
                          ])
                        }
                      />
                      <Button
                        label="保存"
                        variant="primary"
                        isDisabled={data.busy}
                        onClick={() => void saveProfiles()}
                      />
                    </>
                  }
                />
              </Stack>
            </Section>
          ) : null}

          <Stack
            className="terminal-node__tabs nodrag nowheel"
            direction="horizontal"
            gap={1}
          >
            {data.sessions.map((session) => (
              <Stack
                key={session.id}
                className={`terminal-node__tab ${
                  session.id === data.activeSessionId
                    ? "is-active"
                    : session.status === "exited"
                      ? "is-exited"
                      : ""
                }`}
                direction="horizontal"
                gap={0.5}
                align="center"
              >
                <Button
                  label={session.title}
                  type="button"
                  className="terminal-node__tab-main"
                  variant="ghost"
                  onClick={() => data.onSelectTerminal(session.id)}
                >
                  <StatusDot
                    label={session.status === "exited" ? "已退出" : "运行中"}
                    variant={
                      session.status === "exited" ? "neutral" : "success"
                    }
                  />
                  <span>{session.title}</span>
                </Button>
                <IconButton
                  label="关闭终端"
                  tooltip="关闭终端"
                  icon={<X size={12} />}
                  variant="ghost"
                  className="terminal-node__tab-close"
                  onClick={() => void data.onCloseTerminal(session.id)}
                />
              </Stack>
            ))}
          </Stack>

          <div className="terminal-node__viewport nodrag nowheel">
            {activeSession ? (
              <TerminalSessionView
                projectId={data.project.id}
                session={activeSession}
              />
            ) : (
              <EmptyState
                title="还没有终端"
                description="点击标题栏的“新建”或选择一个命令标签来启动。"
                icon={<Terminal size={32} />}
                isCompact
              />
            )}
          </div>

          <Toolbar
            label="终端状态"
            className="terminal-node__statusbar nodrag"
            size="sm"
            variant="muted"
            startContent={
              <Text className="terminal-node__cwd" type="supporting" size="2xs">
                cwd: {data.project.local_path}
              </Text>
            }
            endContent={
              <Text type="supporting" size="2xs">
                {data.terminalDisabled
                  ? "终端不可用"
                  : hasSessions
                    ? activeSession?.status === "exited"
                      ? "已退出"
                      : "运行中"
                    : "就绪"}
              </Text>
            }
          />
        </Stack>
      )}
    </section>
  );
}
