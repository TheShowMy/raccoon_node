// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import TerminalSessionView from "./TerminalSessionView";

const session = {
  id: "term-1",
  project_id: "current",
  title: "dev",
  command: "npm run dev",
  status: "running" as const,
  exit_code: null,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

let dataCallback: ((data: string) => void) | null = null;
let terminalOptions: {
  theme?: Record<string, string>;
} | null = null;
const writeMock = vi.fn();
const writelnMock = vi.fn();
const focusMock = vi.fn();
const disposeMock = vi.fn();
const fitMock = vi.fn();

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation((options) => {
    terminalOptions = options;
    return {
      options,
      open: vi.fn(),
      loadAddon: vi.fn(),
      write: writeMock,
      writeln: writelnMock,
      focus: focusMock,
      dispose: disposeMock,
      onData: (cb: (data: string) => void) => {
        dataCallback = cb;
        return { dispose: vi.fn() };
      },
      cols: 80,
      rows: 24,
    };
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: fitMock,
  })),
}));

class MockWebSocket {
  static last: MockWebSocket | null = null;
  readyState: number = WebSocket.CONNECTING;
  private listeners: Record<
    string,
    Array<(event: Event | MessageEvent | CloseEvent) => void>
  > = {};
  sent: string[] = [];

  constructor() {
    MockWebSocket.last = this;
  }

  addEventListener(
    event: string,
    handler: (event: Event | MessageEvent | CloseEvent) => void,
  ) {
    this.listeners[event] = this.listeners[event] ?? [];
    this.listeners[event].push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
  }

  trigger(event: string, payload?: unknown) {
    const handlers = this.listeners[event] ?? [];
    for (const handler of handlers) {
      if (event === "message") {
        handler(new MessageEvent("message", { data: payload }));
      } else if (event === "close") {
        handler(new CloseEvent("close"));
      } else {
        handler(new Event(event));
      }
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  dataCallback = null;
  terminalOptions = null;
  MockWebSocket.last = null;
  delete document.documentElement.dataset.theme;
  document.documentElement.style.cssText = `
    --canvas-bg: #0b1120;
    --text-strong: #f1f5f9;
    --accent-model: #f97316;
    --card-border-strong: rgba(148, 163, 184, 0.24);
  `;
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

describe("TerminalSessionView", () => {
  it("updates the xterm theme without reconnecting", async () => {
    render(<TerminalSessionView projectId="current" session={session} />);
    await waitFor(() => expect(terminalOptions).not.toBeNull());

    expect(terminalOptions?.theme).toMatchObject({
      background: "#0b1120",
      foreground: "#f1f5f9",
      cursor: "#f97316",
    });
    const socket = MockWebSocket.last;

    act(() => {
      document.documentElement.style.setProperty("--canvas-bg", "#eef3e8");
      document.documentElement.style.setProperty("--text-strong", "#243126");
      document.documentElement.dataset.theme = "light";
    });

    await waitFor(() => {
      expect(terminalOptions?.theme).toMatchObject({
        background: "#eef3e8",
        foreground: "#243126",
      });
    });
    expect(MockWebSocket.last).toBe(socket);
  });

  it("shows connecting status until socket opens", async () => {
    render(<TerminalSessionView projectId="current" session={session} />);
    expect(screen.getByText("正在连接终端…")).toBeInTheDocument();

    await waitFor(() => expect(MockWebSocket.last).not.toBeNull());
    act(() => {
      MockWebSocket.last?.trigger("open");
    });
    await waitFor(() => {
      expect(screen.queryByText("正在连接终端…")).not.toBeInTheDocument();
    });
  });

  it("forwards typed input to the websocket as JSON input messages", async () => {
    render(<TerminalSessionView projectId="current" session={session} />);
    await waitFor(() => expect(dataCallback).not.toBeNull());

    act(() => {
      MockWebSocket.last?.trigger("open");
      dataCallback!("npm run dev\r");
    });

    await waitFor(() => {
      expect(MockWebSocket.last?.sent).toContain(
        JSON.stringify({ type: "input", data: "npm run dev\r" }),
      );
    });
  });

  it("writes output messages to the terminal", async () => {
    render(<TerminalSessionView projectId="current" session={session} />);
    await waitFor(() => expect(MockWebSocket.last).not.toBeNull());

    act(() => {
      MockWebSocket.last?.trigger(
        "message",
        JSON.stringify({ type: "output", data: "hello\n" }),
      );
    });

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith("hello\n");
    });
  });

  it("shows an error overlay when the server reports an error", async () => {
    render(<TerminalSessionView projectId="current" session={session} />);
    await waitFor(() => expect(MockWebSocket.last).not.toBeNull());

    act(() => {
      MockWebSocket.last?.trigger(
        "message",
        JSON.stringify({ type: "error", message: "pty failed" }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("pty failed")).toBeInTheDocument();
    });
  });

  it("writes an exit message when the process exits", async () => {
    render(<TerminalSessionView projectId="current" session={session} />);
    await waitFor(() => expect(MockWebSocket.last).not.toBeNull());

    act(() => {
      MockWebSocket.last?.trigger(
        "message",
        JSON.stringify({ type: "status", status: "exited", exit_code: 0 }),
      );
    });

    await waitFor(() => {
      expect(writelnMock).toHaveBeenCalledWith(
        expect.stringContaining("进程已退出"),
      );
    });
  });

  it("sends a resize message after the socket opens", async () => {
    render(<TerminalSessionView projectId="current" session={session} />);
    await waitFor(() => expect(MockWebSocket.last).not.toBeNull());

    act(() => {
      MockWebSocket.last?.trigger("open");
    });

    await waitFor(() => {
      expect(MockWebSocket.last?.sent).toContain(
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
      );
    });
  });
});
