import { PixelButton } from "@pxlkit/ui-kit";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { getApi } from "../../api";
import { useDomainStore } from "../../store/domainStore";
import { useTerminalStore } from "../../store/terminalStore";
import {
  ToolWorkbench,
  WorkbenchPane,
  WorkbenchToolbar,
} from "../shared/ToolWorkbench";
import { TerminalSessionContent } from "./nodes";
import {
  WorkbenchActionDock,
  workbenchActionSourceKey,
} from "../shared/actionPanels";

/** 终端工作台（FE-TERM-*）：会话标签 + 单一活动 xterm。 */
export function TerminalWorkbench() {
  const terminals = useDomainStore((state) => state.terminals);
  const workbenchActions = useDomainStore((state) => state.workbenchActions);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const sessions = Object.values(terminals).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const terminalActions = Object.values(workbenchActions)
    .filter((action) => action.kind === "terminal_close")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const activeAction =
    terminalActions.find((action) => action.state === "awaiting") ?? null;
  const activeSourceKey = activeAction
    ? workbenchActionSourceKey(activeAction)
    : null;
  const createTerminalMutation = useMutation({
    mutationFn: () => getApi().createTerminal(),
    onSuccess: ({ session_id }) =>
      useTerminalStore.getState().setActiveSessionId(session_id),
  });

  useEffect(() => {
    if (activeSession && activeSession.id !== activeSessionId) {
      useTerminalStore.getState().setActiveSessionId(activeSession.id);
    } else if (!activeSession && activeSessionId) {
      useTerminalStore.getState().setActiveSessionId(null);
    }
  }, [activeSession, activeSessionId]);

  return (
    <ToolWorkbench className="terminal-workbench" ariaLabel="终端工具页">
      <WorkbenchToolbar ariaLabel="终端会话工具栏">
        <div className="terminal-tabs" role="tablist" aria-label="终端会话">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              role="tab"
              aria-selected={activeSession?.id === session.id}
              data-active={activeSession?.id === session.id || undefined}
              onClick={() =>
                useTerminalStore.getState().setActiveSessionId(session.id)
              }
            >
              <span>{session.title}</span>
              <em>{session.state === "running" ? "●" : "○"}</em>
            </button>
          ))}
        </div>
        <PixelButton
          size="sm"
          tone="green"
          disabled={createTerminalMutation.isPending}
          onClick={() => createTerminalMutation.mutate()}
        >
          新建会话
        </PixelButton>
      </WorkbenchToolbar>
      <WorkbenchPane
        paneId="terminal-active-session"
        ariaLabel="当前终端会话"
        className="terminal-workbench__session"
      >
        {activeSession ? (
          <TerminalSessionContent
            session={activeSession}
            actionSourceActive={
              activeSourceKey === `terminal_close:${activeSession.id}`
            }
          />
        ) : (
          <div className="tool-empty-state">
            <strong>尚无终端会话</strong>
            <span>新建后只挂载当前活动的 xterm。</span>
          </div>
        )}
      </WorkbenchPane>
      <WorkbenchActionDock actions={terminalActions} />
    </ToolWorkbench>
  );
}
