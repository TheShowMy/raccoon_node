import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { PixelButton } from "@pxlkit/ui-kit";
import type { NodeProps } from "@xyflow/react";
import { memo, useEffect, useRef, useState } from "react";
import { getApi } from "../../api";
import type { TerminalSession } from "../../api/types";
import { DNode } from "../../components/DNode";
import { useDomainStore } from "../../store/domainStore";
import { useTerminalStore } from "../../store/terminalStore";
import { terminalNodeId } from "./projection";

/* ── 新建会话节点 ── */

export const LauncherNode = memo(function LauncherNode() {
  return (
    <DNode
      icon="terminal"
      label="终端"
      chip="PTY"
      width={280}
      ariaLabel="终端会话管理"
      actions={
        <PixelButton
          size="sm"
          tone="green"
          onClick={() => void useDomainStore.getState().createTerminal()}
        >
          新建会话
        </PixelButton>
      }
    >
      <p className="dnode__text">
        每个 PTY 是独立会话节点；连接断开与进程退出是不同状态。
      </p>
      <p className="dnode__meta">
        关闭运行中会话走确认节点；正文不进入业务事件。
      </p>
    </DNode>
  );
});

/* ── 终端会话节点（xterm.js + fit；主题跟随 token） ── */

const STATE_LABELS: Record<TerminalSession["state"], string> = {
  running: "运行中",
  exited: "已退出",
  disconnected: "已断开",
};

const STATE_TONES: Record<TerminalSession["state"], string> = {
  running: "green",
  exited: "gray",
  disconnected: "red",
};

function readXtermTheme() {
  const styles = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    background: pick("--px-bg", "#151c17"),
    foreground: pick("--px-ink", "#e2efe0"),
    cursor: pick("--px-primary", "#4fce7d"),
    selectionBackground: pick("--px-surface-raised", "#243128"),
  };
}

function XtermPane({ session }: { session: TerminalSession }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new XTerm({
      convertEol: true,
      cursorBlink: session.state === "running",
      disableStdin: session.state !== "running",
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      theme: readXtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    getApi().resizeTerminal({
      session_id: session.id,
      cols: term.cols,
      rows: term.rows,
    });
    // 输出走 mock WebSocket 侧信道（不进入业务事件，FE-TERM-002）
    const unsubscribe = getApi().subscribeTerminalOutput(session.id, (data) =>
      term.write(data),
    );
    const disposable = term.onData(
      (data) => void getApi().terminalInput({ session_id: session.id, data }),
    );
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        void getApi().resizeTerminal({
          session_id: session.id,
          cols: term.cols,
          rows: term.rows,
        });
      } catch {
        // 容器隐藏时 fit 可能失败，忽略
      }
    });
    observer.observe(host);
    // 明暗切换即时生效：token 变化时刷新 xterm 配色
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readXtermTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => {
      themeObserver.disconnect();
      observer.disconnect();
      disposable.dispose();
      unsubscribe();
      term.dispose();
      termRef.current = null;
    };
  }, [session.id, session.state]);

  return (
    <div
      ref={hostRef}
      className="term-pane nodrag nowheel"
      aria-label="终端屏幕"
    />
  );
}

export const TerminalSessionNode = memo(function TerminalSessionNode({
  data,
}: NodeProps) {
  const { session } = data as { session: TerminalSession };
  const renaming = useTerminalStore((state) => state.renamingId === session.id);
  const [titleDraft, setTitleDraft] = useState(session.title);

  const close = () => {
    const domain = useDomainStore.getState();
    if (session.state === "running") {
      // 关闭运行中会话走确认节点（FE-TERM-003）
      void domain.requestWorkbenchAction({
        kind: "terminal_close",
        payload: { session_id: session.id, title: session.title },
        source_node_id: terminalNodeId.session(session.id),
      });
    } else {
      void domain.closeTerminal(session.id);
    }
  };

  return (
    <DNode
      icon="terminal"
      label={session.title}
      chip={STATE_LABELS[session.state]}
      chipTone={STATE_TONES[session.state]}
      width={500}
      ariaLabel={`终端会话 ${session.title}`}
      actions={
        <>
          {session.state === "running" ? (
            <PixelButton
              size="sm"
              variant="outline"
              onClick={() =>
                void useDomainStore.getState().disconnectTerminal(session.id)
              }
            >
              模拟断开
            </PixelButton>
          ) : null}
          {session.state === "disconnected" ? (
            <PixelButton
              size="sm"
              tone="cyan"
              variant="outline"
              onClick={() =>
                void useDomainStore.getState().reconnectTerminal(session.id)
              }
            >
              重连
            </PixelButton>
          ) : null}
          <PixelButton
            size="sm"
            variant="outline"
            onClick={() =>
              useTerminalStore.getState().setRenamingId(session.id)
            }
          >
            重命名
          </PixelButton>
          <PixelButton size="sm" tone="red" variant="outline" onClick={close}>
            关闭
          </PixelButton>
        </>
      }
    >
      {renaming ? (
        <form
          className="dnode__inline-form nodrag nowheel"
          onSubmit={(event) => {
            event.preventDefault();
            void useDomainStore
              .getState()
              .renameTerminal({ session_id: session.id, title: titleDraft });
            useTerminalStore.getState().setRenamingId(null);
          }}
        >
          <input
            className="dnode__input"
            aria-label="会话名称"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
          />
          <PixelButton size="sm" tone="green" type="submit">
            保存名称
          </PixelButton>
        </form>
      ) : null}
      {session.state === "disconnected" ? (
        <p className="dnode__warning">
          连接已断开：输入暂停，进程仍在运行（可重连）。
        </p>
      ) : null}
      {session.state === "exited" ? (
        <p className="dnode__meta">
          进程已退出（exit code {session.exit_code ?? 0}）。
        </p>
      ) : null}
      <XtermPane session={session} />
    </DNode>
  );
});
