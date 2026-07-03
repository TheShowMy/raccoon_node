import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Plus,
  Settings2,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  StartNodeData,
  TerminalCommandProfileDraft,
} from "../../types/api";
import TerminalSessionView from "../terminal/TerminalSessionView";

type TerminalData = Extract<StartNodeData, { kind: "project-terminal" }>;

function useDisabledReason(disabled: boolean, reason?: string): string | null {
  return useMemo(() => {
    if (!disabled) return null;
    if (reason === "listening-on-all-interfaces") {
      return "监听 0.0.0.0 时终端已禁用，请在基础设置中将 host 改为 127.0.0.1";
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
  const ExpandIcon = data.collapsed ? ChevronRight : ChevronDown;
  const disabledReason = useDisabledReason(
    data.terminalDisabled,
    data.terminalDisabledReason,
  );

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

  return (
    <section
      className={`terminal-node ${data.collapsed ? "terminal-node--collapsed" : ""}`}
    >
      {data.collapsed ? (
        <button
          type="button"
          className="terminal-node__collapsed-bar nodrag"
          aria-expanded={!data.collapsed}
          onClick={data.onToggleCollapsed}
        >
          <span className="terminal-node__icon" aria-hidden="true">
            <Terminal size={17} />
          </span>
          <span className="terminal-node__collapsed-copy">
            <strong>项目终端</strong>
            <small>
              {hasSessions
                ? `${data.sessions.length} 个终端 · ${activeSession?.title ?? "未选择"}`
                : "默认在项目根目录启动"}
            </small>
          </span>
          {data.error ? (
            <span className="terminal-node__error">{data.error}</span>
          ) : null}
          <ExpandIcon size={16} />
        </button>
      ) : (
        <div className="terminal-node__body">
          <header className="terminal-node__titlebar nodrag">
            <span className="terminal-node__icon" aria-hidden="true">
              <Terminal size={17} />
            </span>
            <span className="terminal-node__title">项目终端</span>
            <div className="terminal-node__titlebar-actions">
              {data.error ? (
                <span className="terminal-node__error">{data.error}</span>
              ) : null}
              <button
                type="button"
                aria-label="新建"
                disabled={data.busy || data.terminalDisabled}
                onClick={() => void data.onCreateTerminal()}
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                aria-label="收起"
                onClick={data.onToggleCollapsed}
              >
                <ChevronDown size={16} />
              </button>
            </div>
          </header>

          {disabledReason ? (
            <div className="terminal-node__notice nodrag">
              <AlertTriangle size={14} />
              <span>{disabledReason}</span>
            </div>
          ) : null}

          <div className="terminal-node__toolbar nodrag">
            <div className="terminal-node__command-list">
              {data.commandProfiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  disabled={data.busy || data.terminalDisabled}
                  className="terminal-node__command-tag"
                  onClick={() =>
                    void data.onCreateTerminal(profile.command, profile.name)
                  }
                >
                  <Terminal size={10} />
                  {profile.name}
                </button>
              ))}
              {data.commandProfiles.length === 0 ? (
                <span className="terminal-node__command-hint">
                  暂无自定义启动命令
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="terminal-node__manage"
              onClick={openProfileEditor}
            >
              <Settings2 size={13} />
              管理命令
            </button>
          </div>

          {editingProfiles ? (
            <div className="terminal-node__profiles nodrag">
              <div className="terminal-node__profiles-head">
                <strong>自定义启动命令</strong>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={() => setEditingProfiles(false)}
                >
                  <X size={14} />
                </button>
              </div>
              {draftProfiles.map((profile, index) => (
                <div
                  key={profile.id ?? index}
                  className="terminal-node__profile-row"
                >
                  <input
                    value={profile.name}
                    placeholder="名称"
                    onChange={(event) =>
                      setDraftProfiles((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, name: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <input
                    value={profile.command}
                    placeholder="命令，例如 npm run dev"
                    onChange={(event) =>
                      setDraftProfiles((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, command: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-label="删除命令"
                    onClick={() =>
                      setDraftProfiles((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <div className="terminal-node__profiles-actions">
                <button
                  type="button"
                  onClick={() =>
                    setDraftProfiles((current) => [
                      ...current,
                      { name: "", command: "" },
                    ])
                  }
                >
                  添加命令
                </button>
                <button
                  type="button"
                  disabled={data.busy}
                  onClick={() => void saveProfiles()}
                >
                  保存
                </button>
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
                <button
                  type="button"
                  className="terminal-node__tab-main"
                  onClick={() => data.onSelectTerminal(session.id)}
                >
                  <span
                    className={`terminal-node__tab-dot ${session.status === "exited" ? "is-exited" : "is-running"}`}
                  />
                  <span>{session.title}</span>
                </button>
                <button
                  type="button"
                  aria-label="关闭终端"
                  className="terminal-node__tab-close"
                  onClick={() => void data.onCloseTerminal(session.id)}
                >
                  <X size={12} />
                </button>
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
