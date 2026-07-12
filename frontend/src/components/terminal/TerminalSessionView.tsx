import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "@xterm/xterm/css/xterm.css";
import { terminalWebSocketUrl } from "../../api/client";
import type { TerminalServerMessage, TerminalSession } from "../../types/api";

type OverlayPlacement = {
  root: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
};

function terminalTheme(fixedDark: boolean) {
  if (fixedDark) {
    return {
      background: "#0b1120",
      foreground: "#e2e8f0",
      cursor: "#f59e0b",
      selectionBackground: "#334155",
      black: "#0f172a",
      red: "#fb7185",
      green: "#4ade80",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e2e8f0",
      brightBlack: "#64748b",
      brightRed: "#fda4af",
      brightGreen: "#86efac",
      brightYellow: "#fde047",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9",
      brightWhite: "#f8fafc",
    };
  }
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string) => styles.getPropertyValue(name).trim();

  return {
    background: color("--color-background-surface"),
    foreground: color("--color-text-primary"),
    cursor: color("--color-accent"),
    selectionBackground: color("--color-border-emphasized"),
  };
}

function readOverlayPlacement(element: HTMLElement): OverlayPlacement {
  const root = element.closest<HTMLElement>(".canvas-shell") ?? document.body;
  const rect = element.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();

  return {
    root,
    left: rect.left - rootRect.left,
    top: rect.top - rootRect.top,
    width: rect.width,
    height: rect.height,
  };
}

function sameOverlayPlacement(
  a: OverlayPlacement | null,
  b: OverlayPlacement | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.root !== b.root) return false;
  const threshold = 0.5;
  return (
    Math.abs(a.left - b.left) < threshold &&
    Math.abs(a.top - b.top) < threshold &&
    Math.abs(a.width - b.width) < threshold &&
    Math.abs(a.height - b.height) < threshold
  );
}

export default function TerminalSessionView({
  projectId,
  session,
  fixedDark = false,
}: {
  projectId: string;
  session: TerminalSession;
  fixedDark?: boolean;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [overlayPlacement, setOverlayPlacement] =
    useState<OverlayPlacement | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "closed"
  >("connecting");
  const [error, setError] = useState<string | null>(null);
  const overlayReady = overlayPlacement !== null;

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    let frame = 0;
    const syncPlacement = () => {
      const next = readOverlayPlacement(anchor);
      setOverlayPlacement((current) =>
        sameOverlayPlacement(current, next) ? current : next,
      );
      frame = window.requestAnimationFrame(syncPlacement);
    };

    syncPlacement();
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!overlayReady) return;
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
            getComputedStyle(document.documentElement)
              .getPropertyValue("--font-mono")
              .trim() ||
            "JetBrains Mono, Cascadia Mono, SFMono-Regular, Consolas, monospace",
          fontSize: 12,
          theme: terminalTheme(fixedDark),
        });
        const themeObserver = fixedDark
          ? null
          : new MutationObserver(() => {
              terminal.options.theme = terminalTheme(false);
            });
        themeObserver?.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        const fit = new fitAddon.FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        fit.fit();

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
          themeObserver?.disconnect();
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
  }, [fixedDark, overlayReady, projectId, session.id]);

  const status =
    connectionStatus !== "connected" || error ? (
      <div className="terminal-session-view__status">
        {error ??
          (connectionStatus === "connecting"
            ? "正在连接终端…"
            : "终端连接已断开")}
      </div>
    ) : null;

  return (
    <>
      <div
        ref={anchorRef}
        className={`terminal-session-view nodrag nowheel${fixedDark ? " terminal-session-view--fixed-dark" : ""}`}
      />
      {overlayPlacement
        ? createPortal(
            <div
              className={`terminal-session-view__overlay nodrag nowheel${fixedDark ? " terminal-session-view--fixed-dark" : ""}`}
              style={{
                left: overlayPlacement.left,
                top: overlayPlacement.top,
                width: overlayPlacement.width,
                height: overlayPlacement.height,
              }}
            >
              <div ref={hostRef} className="terminal-session-view__host" />
              {status}
            </div>,
            overlayPlacement.root,
          )
        : null}
    </>
  );
}
