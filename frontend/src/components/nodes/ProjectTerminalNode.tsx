import {
  AlertTriangle,
  KeyRound,
  Plus,
  Settings2,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
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
              <span className="terminal-node__error">{data.error}</span>
            ) : null
          }
        />
      ) : (
        <div className="terminal-node__body">
          <NodeBar
            icon={<Terminal size={16} />}
            accent="var(--accent-projects)"
            title="项目终端"
            expanded={true}
            onToggle={data.onToggleCollapsed}
            actions={
              <>
                {data.error ? (
                  <span className="terminal-node__error">{data.error}</span>
                ) : null}
                <IconButton
                  label="新建"
                  tooltip="新建终端"
                  icon={<Plus size={14} />}
                  size="sm"
                  variant="ghost"
                  isDisabled={data.busy || data.terminalDisabled}
                  onClick={() => void data.onCreateTerminal()}
                />
              </>
            }
          />

          {disabledReason ? (
            <div className="terminal-node__notice nodrag">
              <AlertTriangle size={14} />
              <span>{disabledReason}</span>
            </div>
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
            <div className="terminal-node__access-status nodrag">
              <KeyRound size={14} />
              <span>
                终端已授权至{" "}
                {new Date(data.terminalAccessExpiresAt).toLocaleTimeString()}
              </span>
            </div>
          ) : null}

          <div className="terminal-node__toolbar nodrag">
            <div className="terminal-node__command-list">
              {data.commandProfiles.map((profile) => (
                <Button
                  key={profile.id}
                  label={profile.name}
                  size="sm"
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
                <span className="terminal-node__command-hint">
                  暂无自定义启动命令
                </span>
              ) : null}
            </div>
            <Button
              label="管理命令"
              size="sm"
              variant="ghost"
              icon={<Settings2 size={13} />}
              className="terminal-node__manage"
              onClick={openProfileEditor}
            />
          </div>

          {editingProfiles ? (
            <div className="terminal-node__profiles nodrag">
              <div className="terminal-node__profiles-head">
                <strong>自定义启动命令</strong>
                <IconButton
                  label="关闭"
                  tooltip="关闭"
                  icon={<X size={14} />}
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditingProfiles(false)}
                />
              </div>
              {draftProfiles.map((profile, index) => (
                <div
                  key={profile.id ?? index}
                  className="terminal-node__profile-row"
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
                          itemIndex === index ? { ...item, name: value } : item,
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
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDraftProfiles((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  />
                </div>
              ))}
              <div className="terminal-node__profiles-actions">
                <Button
                  label="添加命令"
                  size="sm"
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
                  size="sm"
                  variant="primary"
                  isDisabled={data.busy}
                  onClick={() => void saveProfiles()}
                />
              </div>
            </div>
          ) : null}

          <div className="terminal-node__tabs nodrag nowheel">
            {data.sessions.map((session) => (
              <div
                key={session.id}
                className={`terminal-node__tab ${
                  session.id === data.activeSessionId
                    ? "is-active"
                    : session.status === "exited"
                      ? "is-exited"
                      : ""
                }`}
              >
                <Button
                  label={session.title}
                  type="button"
                  className="terminal-node__tab-main"
                  onClick={() => data.onSelectTerminal(session.id)}
                >
                  <span
                    className={`terminal-node__tab-dot ${session.status === "exited" ? "is-exited" : "is-running"}`}
                  />
                  <span>{session.title}</span>
                </Button>
                <IconButton
                  label="关闭终端"
                  tooltip="关闭终端"
                  icon={<X size={12} />}
                  size="sm"
                  variant="ghost"
                  className="terminal-node__tab-close"
                  onClick={() => void data.onCloseTerminal(session.id)}
                />
              </div>
            ))}
          </div>

          <div className="terminal-node__viewport nodrag nowheel">
            {activeSession ? (
              <TerminalSessionView
                projectId={data.project.id}
                session={activeSession}
              />
            ) : (
              <div className="terminal-node__empty">
                <Terminal size={32} />
                <strong>还没有终端</strong>
                <span>点击标题栏的“新建”或选择一个命令标签来启动。</span>
              </div>
            )}
          </div>

          <footer className="terminal-node__statusbar nodrag">
            <span className="terminal-node__cwd">
              cwd: {data.project.local_path}
            </span>
            <span>
              {data.terminalDisabled
                ? "终端不可用"
                : hasSessions
                  ? activeSession?.status === "exited"
                    ? "已退出"
                    : "运行中"
                  : "就绪"}
            </span>
          </footer>
        </div>
      )}
    </section>
  );
}
