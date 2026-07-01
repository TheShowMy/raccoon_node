import {
  ChevronDown,
  ChevronRight,
  Plus,
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
      <button
        type="button"
        className="terminal-node__collapsed-bar nodrag"
        aria-expanded={!data.collapsed}
        onClick={data.onToggleCollapsed}
      >
        <span className="node-icon terminal-node__icon">
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

      {data.collapsed ? null : (
        <div className="terminal-node__body">
          <header className="terminal-node__header">
            <div>
              <strong>项目终端</strong>
              <span>{data.project.name} · 命令在项目根目录执行</span>
            </div>
            <div className="terminal-node__header-actions nodrag">
              {data.terminalDisabled ? (
                <span className="terminal-node__security">
                  监听 0.0.0.0 时终端已禁用
                </span>
              ) : null}
              <button
                type="button"
                disabled={data.busy || data.terminalDisabled}
                onClick={() => void data.onCreateTerminal()}
              >
                <Plus size={13} />
                新建
              </button>
              <button type="button" onClick={data.onToggleCollapsed}>
                收起
              </button>
            </div>
          </header>

          <div className="terminal-node__commands nodrag">
            {data.commandProfiles.map((profile) => (
              <button
                key={`${profile.name}:${profile.command}`}
                type="button"
                disabled={data.busy || data.terminalDisabled}
                className="terminal-node__command-chip"
                onClick={() =>
                  void data.onCreateTerminal(profile.command, profile.name)
                }
              >
                {profile.name}
              </button>
            ))}
            {data.commandProfiles.length === 0 ? (
              <span className="terminal-node__command-empty">
                暂无自定义启动命令
              </span>
            ) : null}
            <button
              type="button"
              className="terminal-node__manage-command"
              onClick={openProfileEditor}
            >
              管理命令
            </button>
          </div>

          {editingProfiles ? (
            <div className="terminal-node__profiles nodrag">
              <div className="terminal-node__profiles-head">
                <strong>自定义启动命令</strong>
                <button type="button" onClick={() => setEditingProfiles(false)}>
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
              <button
                key={session.id}
                type="button"
                className={
                  session.id === data.activeSessionId ? "is-active" : ""
                }
                onClick={() => data.onSelectTerminal(session.id)}
              >
                <span>{session.title}</span>
                <small>
                  {session.status === "exited" ? "已退出" : "运行中"}
                </small>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="关闭终端"
                  className="terminal-node__tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    void data.onCloseTerminal(session.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      void data.onCloseTerminal(session.id);
                    }
                  }}
                >
                  <X size={12} />
                </span>
              </button>
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
                <Terminal size={24} />
                <strong>还没有终端</strong>
                <span>点击“新建”，或先添加自定义启动命令。</span>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
