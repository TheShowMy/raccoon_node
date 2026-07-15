// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortProjectChat,
  getProjectChat,
  resetProjectChat,
  sendProjectChatMessage,
} from "../api/client";
import type { ConversationEvent, ProjectChatResponse } from "../types/api";
import { useProjectChat } from "./useProjectChat";

vi.mock("../api/client", () => ({
  abortProjectChat: vi.fn(),
  getProjectChat: vi.fn(),
  projectChatWebSocketUrl: () => "ws://test/chat",
  resetProjectChat: vi.fn(),
  sendProjectChatMessage: vi.fn(),
}));

const response: ProjectChatResponse = {
  messages: [],
  mode: "qa",
  active_requirement_id: null,
  running: false,
  error: null,
  updated_at: "2026-06-25T00:00:00Z",
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.onopen?.();
  }

  emit(event: ConversationEvent) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  }

  disconnect() {
    this.onclose?.();
  }
}

describe("useProjectChat", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.mocked(getProjectChat).mockResolvedValue(response);
    vi.mocked(sendProjectChatMessage).mockResolvedValue({
      accepted: true,
      turn_id: "turn-1",
    });
    vi.mocked(abortProjectChat).mockResolvedValue({ accepted: true });
    vi.mocked(resetProjectChat).mockResolvedValue(response);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("subscribes before loading the snapshot and buffers events during sync", async () => {
    let resolveSnapshot!: (value: ProjectChatResponse) => void;
    vi.mocked(getProjectChat).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const { result } = renderHook(() => useProjectChat());
    const socket = FakeWebSocket.instances[0];

    expect(socket.url).toBe("ws://test/chat");
    expect(getProjectChat).not.toHaveBeenCalled();
    act(() => socket.open());
    act(() =>
      socket.emit({
        type: "agent.event",
        payload: {
          pi_type: "message_update",
          event: {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "回答" },
          },
        },
      }),
    );
    expect(result.current.projectChatEvents).toHaveLength(0);

    await act(async () => resolveSnapshot(response));
    await waitFor(() => expect(result.current.projectChat).toEqual(response));
    expect(result.current.projectChatEvents).toHaveLength(1);
  });

  it("reconciles final events with the persisted snapshot", async () => {
    const { result } = renderHook(() => useProjectChat());
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.projectChat).toEqual(response));

    vi.mocked(getProjectChat).mockResolvedValueOnce({
      ...response,
      messages: [
        {
          role: "assistant",
          content: "回答完成",
          created_at: response.updated_at,
        },
      ],
    });
    act(() =>
      socket.emit({
        type: "snapshot.changed",
        payload: {},
      }),
    );

    await waitFor(() =>
      expect(result.current.projectChat?.messages).toHaveLength(1),
    );
    expect(result.current.projectChatEvents).toHaveLength(0);
  });

  it("keeps live process events when a running snapshot is reconciled", async () => {
    const { result } = renderHook(() => useProjectChat());
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.projectChat).toEqual(response));

    act(() =>
      socket.emit({
        type: "agent.event",
        payload: {
          pi_type: "tool_execution_start",
          event: {
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "read",
          },
        },
      }),
    );
    expect(result.current.projectChatEvents.map((event) => event.type)).toEqual(
      ["agent.event"],
    );

    vi.mocked(getProjectChat).mockResolvedValueOnce({
      ...response,
      running: true,
    });
    act(() =>
      socket.emit({
        type: "snapshot.changed",
        payload: {},
      }),
    );

    await waitFor(() => expect(result.current.projectChat?.running).toBe(true));
    expect(result.current.projectChatEvents.map((event) => event.type)).toEqual(
      ["agent.event", "snapshot.changed"],
    );
  });

  it("resyncs a reconnected socket after the previous snapshot fails", async () => {
    vi.useFakeTimers();
    let rejectSnapshot!: (reason: Error) => void;
    vi.mocked(getProjectChat)
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectSnapshot = reject;
        }),
      )
      .mockResolvedValueOnce(response);
    const { result, unmount } = renderHook(() => useProjectChat());
    const first = FakeWebSocket.instances[0];

    act(() => first.open());
    act(() => first.disconnect());
    act(() => vi.advanceTimersByTime(500));
    const second = FakeWebSocket.instances[1];
    act(() => second.open());
    expect(getProjectChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectSnapshot(new Error("旧连接已断开"));
      await Promise.resolve();
    });

    expect(getProjectChat).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.projectChat).toEqual(response);
    unmount();
  });

  it("accepts a message payload and waits for websocket state", async () => {
    const { result } = renderHook(() => useProjectChat());
    act(() => FakeWebSocket.instances[0].open());
    await waitFor(() => expect(result.current.projectChat).toEqual(response));

    await act(async () =>
      result.current.sendProjectChat({
        message: "  项目入口在哪？  ",
        references: [],
        images: [],
      }),
    );

    expect(sendProjectChatMessage).toHaveBeenCalledWith({
      message: "项目入口在哪？",
      references: [],
      images: [],
    });
    expect(result.current.projectChat?.running).toBe(true);
  });
});
