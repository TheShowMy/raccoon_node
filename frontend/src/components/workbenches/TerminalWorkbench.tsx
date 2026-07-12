import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutPanel,
  VStack,
} from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { Lock, Plus, Shield, Terminal, X } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import TerminalAccessForm from "../terminal/TerminalAccessForm";
import TerminalSessionView from "../terminal/TerminalSessionView";

type TerminalData = Extract<StartNodeData, { kind: "project-terminal" }>;

function TerminalStatusCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <VStack gap={3} align="center" padding={4} style={{ maxWidth: "640px" }}>
      {icon}
      <Heading level={3}>{title}</Heading>
      <div style={{ textAlign: "center" }}>
        <Text type="supporting">{description}</Text>
      </div>
      {children}
    </VStack>
  );
}

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

  const sidebar = data.terminalDisabled ? (
    <VStack gap={2} align="center" justify="center" height="100%">
      <Terminal size={24} />
      <Text weight="semibold">终端未启用</Text>
      <div style={{ textAlign: "center" }}>
        <Text type="supporting" size="2xs">
          {disabledReason ?? "终端当前不可用"}
        </Text>
      </div>
    </VStack>
  ) : (
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
                session.id === data.activeSessionId ? "secondary" : "ghost"
              }
              icon={
                <StatusDot
                  label={session.status === "exited" ? "已退出" : "运行中"}
                  variant={session.status === "exited" ? "neutral" : "success"}
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
  );

  const mainContent = (() => {
    if (data.terminalDisabled) {
      if (data.terminalDisabledReason === "terminal-authorization-required") {
        return (
          <TerminalStatusCard
            icon={<Lock size={40} />}
            title="终端需要启动密钥"
            description="监听 0.0.0.0 时需要输入本次启动的终端密钥以启用终端访问。"
          >
            <TerminalAccessForm
              accessKey={accessKey}
              accessError={data.terminalAccessError}
              accessBusy={data.terminalAccessBusy}
              onChange={setAccessKey}
              onSubmit={authorize}
            />
          </TerminalStatusCard>
        );
      }
      if (data.terminalDisabledReason === "non-localhost-access") {
        return (
          <TerminalStatusCard
            icon={<Shield size={40} />}
            title="终端仅支持本地访问"
            description="当前主机不是 localhost 或 127.0.0.1，终端功能不可用。"
          />
        );
      }
      return (
        <TerminalStatusCard
          icon={<Terminal size={40} />}
          title="终端当前不可用"
          description={disabledReason ?? "终端功能当前无法使用。"}
        />
      );
    }

    if (data.terminalAccessRequired && !data.terminalAccessAuthorized) {
      return (
        <TerminalStatusCard
          icon={<Lock size={40} />}
          title="终端需要授权"
          description="使用终端前需要输入启动密钥完成授权。"
        >
          <TerminalAccessForm
            accessKey={accessKey}
            accessError={data.terminalAccessError}
            accessBusy={data.terminalAccessBusy}
            onChange={setAccessKey}
            onSubmit={authorize}
          />
        </TerminalStatusCard>
      );
    }

    if (activeSession) {
      return (
        <TerminalSessionView
          projectId={data.project.id}
          session={activeSession}
        />
      );
    }

    return (
      <TerminalStatusCard
        icon={<Terminal size={40} />}
        title="新建或选择一个终端会话"
        description="从左侧选择已有会话，或点击新建按钮创建终端。"
      />
    );
  })();

  return (
    <Layout
      height="fill"
      start={
        <LayoutPanel width={300} padding={2} hasDivider isScrollable>
          {sidebar}
        </LayoutPanel>
      }
    >
      <LayoutContent padding={0} isScrollable={false}>
        <VStack height="100%" minHeight={0} justify="center" align="center">
          {data.error ? (
            <Banner
              status="error"
              title="终端操作失败"
              description={data.error}
            />
          ) : null}
          {mainContent}
        </VStack>
      </LayoutContent>
    </Layout>
  );
}
