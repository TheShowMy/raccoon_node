import { useMemo, useState, type FormEvent } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutPanel,
  VStack,
} from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { Plus, Terminal, X } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import TerminalSessionView from "../terminal/TerminalSessionView";

type TerminalData = Extract<StartNodeData, { kind: "project-terminal" }>;

export default function TerminalWorkbench({ data }: { data: TerminalData }) {
  const [accessKey, setAccessKey] = useState("");
  const activeSession = useMemo(
    () =>
      data.sessions.find((item) => item.id === data.activeSessionId) ?? null,
    [data.activeSessionId, data.sessions],
  );
  const disabledReason = data.terminalDisabled
    ? data.terminalDisabledReason === "terminal-authorization-required"
      ? "监听 0.0.0.0 时需要输入本次启动的终端密钥"
      : data.terminalDisabledReason === "non-localhost-access"
        ? "终端仅能通过 localhost 或 127.0.0.1 使用"
        : "终端当前不可用"
    : null;
  const authorize = async (event: FormEvent<HTMLElement>) => {
    event.preventDefault();
    if (await data.onAuthorizeTerminalAccess(accessKey)) setAccessKey("");
  };

  return (
    <Layout
      height="fill"
      start={
        <LayoutPanel width={300} padding={2} hasDivider isScrollable>
          <VStack gap={3}>
            <Toolbar
              label="终端会话"
              startContent={<Text weight="semibold">终端会话</Text>}
              endContent={
                <Button
                  label="新建"
                  tooltip="新建终端"
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  icon={<Plus size={15} />}
                  isDisabled={data.busy || data.terminalDisabled}
                  onClick={() => void data.onCreateTerminal()}
                />
              }
            />
            <HStack gap={1} wrap="wrap">
              {data.commandProfiles.map((profile) => (
                <Button
                  key={profile.id}
                  label={profile.name}
                  size="sm"
                  variant="secondary"
                  icon={<Terminal size={13} />}
                  isDisabled={data.busy || data.terminalDisabled}
                  onClick={() =>
                    void data.onCreateTerminal(profile.command, profile.name)
                  }
                />
              ))}
            </HStack>
            <VStack gap={1}>
              {data.sessions.map((session) => (
                <HStack key={session.id} gap={1} align="center">
                  <Button
                    label={session.title}
                    variant={
                      session.id === data.activeSessionId
                        ? "secondary"
                        : "ghost"
                    }
                    icon={
                      <StatusDot
                        label={
                          session.status === "exited" ? "已退出" : "运行中"
                        }
                        variant={
                          session.status === "exited" ? "neutral" : "success"
                        }
                      />
                    }
                    onClick={() => data.onSelectTerminal(session.id)}
                  />
                  <Button
                    label={`关闭 ${session.title}`}
                    tooltip="关闭终端"
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    icon={<X size={13} />}
                    onClick={() => void data.onCloseTerminal(session.id)}
                  />
                </HStack>
              ))}
            </VStack>
          </VStack>
        </LayoutPanel>
      }
    >
      <LayoutContent padding={0} isScrollable={false}>
        <VStack height="100%" minHeight={0}>
          {disabledReason ? (
            <Banner status="warning" title={disabledReason} />
          ) : null}
          {data.error ? (
            <Banner
              status="error"
              title="终端操作失败"
              description={data.error}
            />
          ) : null}
          {data.terminalAccessRequired && !data.terminalAccessAuthorized ? (
            <HStack
              as="form"
              gap={2}
              padding={3}
              align="center"
              onSubmit={(event) => void authorize(event)}
            >
              <TextInput
                label="终端密钥"
                type="password"
                value={accessKey}
                placeholder="输入启动密钥"
                onChange={setAccessKey}
              />
              <Button
                type="submit"
                label="启用终端"
                isLoading={data.terminalAccessBusy}
                isDisabled={!accessKey.trim()}
              />
              <Text type="supporting" color="secondary">
                {data.terminalAccessError ?? "授权有效期为 12 小时"}
              </Text>
            </HStack>
          ) : null}
          {activeSession ? (
            <TerminalSessionView
              projectId={data.project.id}
              session={activeSession}
            />
          ) : (
            <EmptyState title="新建或选择一个终端会话" isCompact />
          )}
        </VStack>
      </LayoutContent>
    </Layout>
  );
}
