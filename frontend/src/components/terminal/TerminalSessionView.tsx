import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { terminalWebSocketUrl } from "../../api/client";
import type { TerminalServerMessage, TerminalSession } from "../../types/api";

export default function TerminalSessionView({
  projectId,
  session,
}: {
  projectId: string;
  session: TerminalSession;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "closed"
  >("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;
    setConnectionStatus("connecting");
    setError(null);

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([xterm, fitAddon]) => {
        if (disposed) return;

        const terminal = new xterm.Terminal({
          cursorBlink: true,
          convertEol: true,
          fontFamily:
            "JetBrains Mono, Cascadia Mono, SFMono-Regular, Consolas, monospace",
          fontSize: 12,
          rows: 24,
          theme: {
            background: "#020617",
            foreground: "#e2e8f0",
            cursor: "#f97316",
            selectionBackground: "#334155",
          },
        });
        const fit = new fitAddon.FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);

        const socket = new WebSocket(
          terminalWebSocketUrl(projectId, session.id),
        );
        socketRef.current = socket;

        function sendResize() {
          try {
            fit.fit();
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "resize",
                  cols: terminal.cols,
                  rows: terminal.rows,
                }),
              );
            }
          } catch {
            // xterm can throw while its container is detached during React Flow layout.
          }
        }

        const resizeObserver = new ResizeObserver(() => sendResize());
        resizeObserver.observe(host);

        const dataDisposable = terminal.onData((data) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "input", data }));
          }
        });

        const focusTerminal = () => terminal.focus();
        host.addEventListener("pointerdown", focusTerminal);
        host.addEventListener("click", focusTerminal);
        socket.addEventListener("open", () => {
          setConnectionStatus("connected");
          setError(null);
          sendResize();
          terminal.focus();
        });
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(
            String(event.data),
          ) as TerminalServerMessage;
          if (message.type === "output") {
            terminal.write(message.data);
          } else if (message.type === "error") {
            setError(message.message);
          } else if (message.type === "status" && message.status === "exited") {
            terminal.writeln(
              `\r\n\x1b[33m[进程已退出，退出码 ${message.exit_code ?? "未知"}]\x1b[0m`,
            );
          }
        });
        socket.addEventListener("close", () => setConnectionStatus("closed"));
        socket.addEventListener("error", () => {
          setError("终端连接失败");
          setConnectionStatus("closed");
        });

        const frame = window.requestAnimationFrame(sendResize);
        cleanup = () => {
          window.cancelAnimationFrame(frame);
          dataDisposable.dispose();
          resizeObserver.disconnect();
          host.removeEventListener("pointerdown", focusTerminal);
          host.removeEventListener("click", focusTerminal);
          socket.close();
          terminal.dispose();
          if (socketRef.current === socket) socketRef.current = null;
        };
        if (disposed) cleanup();
      })
      .catch(() => {
        if (!disposed) {
          setError("终端组件加载失败");
          setConnectionStatus("closed");
        }
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [projectId, session.id]);

  return (
    <div className="terminal-session-view nodrag nowheel">
      <div ref={hostRef} className="terminal-session-view__host" />
      {connectionStatus !== "connected" || error ? (
        <div className="terminal-session-view__status">
          {error ??
            (connectionStatus === "connecting"
              ? "正在连接终端…"
              : "终端连接已断开")}
        </div>
      ) : null}
    </div>
  );
}
