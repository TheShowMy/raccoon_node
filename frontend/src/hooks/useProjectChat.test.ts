// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortProjectChat,
  generateProjectRequirementSummary,
  getProjectChat,
  resetProjectChat,
  sendProjectChatMessage,
} from "../api/client";
import type { ConversationEvent, ProjectChatResponse } from "../types/api";
import { useProjectChat } from "./useProjectChat";

vi.mock("../api/client", () => ({
  abortProjectChat: vi.fn(),
  generateProjectRequirementSummary: vi.fn(),
  getProjectChat: vi.fn(),
  projectChatWebSocketUrl: (id: string) => `ws://test/${id}`,
  resetProjectChat: vi.fn(),
  sendProjectChatMessage: vi.fn(),
}));

const response: ProjectChatResponse = {
  project_id: "project-1",
  messages: [],
  running: false,
  error: null,
  requirement_summary: null,
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
    vi.mocked(generateProjectRequirementSummary).mockResolvedValue({
      accepted: true,
      turn_id: "turn-summary",
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
    const { result } = renderHook(() => useProjectChat("project-1"));
    const socket = FakeWebSocket.instances[0];

    expect(socket.url).toBe("ws://test/project-1");
    expect(getProjectChat).not.toHaveBeenCalled();
    act(() => socket.open());
    act(() =>
      socket.emit({
        type: "assistant.delta",
        payload: { project_id: "project-1", delta: "回答" },
      }),
    );
    expect(result.current.projectChatEvents).toHaveLength(0);

    await act(async () => resolveSnapshot(response));
    await waitFor(() => expect(result.current.projectChat).toEqual(response));
    expect(result.current.projectChatEvents).toHaveLength(1);
  });

  it("reconciles final events with the persisted snapshot", async () => {
    const { result } = renderHook(() => useProjectChat("project-1"));
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
        type: "message.end",
        payload: { project_id: "project-1" },
      }),
    );

    await waitFor(() =>
      expect(result.current.projectChat?.messages).toHaveLength(1),
    );
    expect(result.current.projectChatEvents).toHaveLength(0);
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
    const { result, unmount } = renderHook(() => useProjectChat("project-1"));
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

  it("accepts a message, clears attachments, and waits for websocket state", async () => {
    const { result } = renderHook(() => useProjectChat("project-1"));
    act(() => FakeWebSocket.instances[0].open());
    await waitFor(() => expect(result.current.projectChat).toEqual(response));

    act(() => result.current.setProjectChatInput("  项目入口在哪？  "));
    await act(async () => result.current.sendProjectChat());

    expect(sendProjectChatMessage).toHaveBeenCalledWith("project-1", {
      message: "项目入口在哪？",
      references: [],
      images: [],
    });
    expect(result.current.projectChatInput).toBe("");
    expect(result.current.projectChat?.running).toBe(true);
  });

  it("runs the requirement command without sending a user message", async () => {
    const { result } = renderHook(() => useProjectChat("project-1"));
    act(() => FakeWebSocket.instances[0].open());
    await waitFor(() => expect(result.current.projectChat).toEqual(response));
    act(() => result.current.setProjectChatInput("/生成需求说明"));

    await act(async () => result.current.generateRequirementSummary());

    expect(generateProjectRequirementSummary).toHaveBeenCalledWith("project-1");
    expect(sendProjectChatMessage).not.toHaveBeenCalled();
    expect(result.current.projectChatInput).toBe("");
  });
});
