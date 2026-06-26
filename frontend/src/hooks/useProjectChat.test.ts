// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectChat, sendProjectChatMessage } from "../api/client";
import type { ProjectChatEvent, ProjectChatResponse } from "../types/api";
import { useProjectChat } from "./useProjectChat";

vi.mock("../api/client", () => ({
  getProjectChat: vi.fn(),
  sendProjectChatMessage: vi.fn(),
}));

const response: ProjectChatResponse = {
  project_id: "project-1",
  messages: [],
  running: false,
  error: null,
  updated_at: "2026-06-25T00:00:00Z",
};

type MessageHandler = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: MessageHandler | null = null;
  listeners = new Map<string, MessageHandler[]>();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const handler = listener as MessageHandler;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  emit(type: string, payload: ProjectChatEvent) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("useProjectChat", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(getProjectChat).mockResolvedValue(response);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads project chat and refreshes persisted messages after project completion", async () => {
    const { result } = renderHook(() => useProjectChat("project-1"));

    await waitFor(() => expect(result.current.projectChat).toEqual(response));
    expect(FakeEventSource.instances[0].url).toBe(
      "/api/projects/project-1/chat/events",
    );

    act(() => {
      FakeEventSource.instances[0].emit("pi_event", {
        project_id: "project-1",
        event: "pi_event",
        message: "本轮处理完成",
        pi_type: "turn_end",
      });
    });

    await waitFor(() => {
      expect(result.current.projectChatEvents).toHaveLength(1);
    });
    expect(getProjectChat).toHaveBeenCalledTimes(1);

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

    act(() => {
      FakeEventSource.instances[0].emit("project_chat_completed", {
        project_id: "project-1",
        event: "project_chat_completed",
        message: "完成",
      });
    });

    await waitFor(() => {
      expect(result.current.projectChat?.messages).toHaveLength(1);
      expect(result.current.projectChatEvents).toHaveLength(0);
      expect(getProjectChat).toHaveBeenCalledTimes(2);
    });
  });

  it("refreshes persisted state after project chat failure", async () => {
    const { result } = renderHook(() => useProjectChat("project-1"));
    await waitFor(() => expect(result.current.projectChat).toEqual(response));

    vi.mocked(getProjectChat).mockResolvedValueOnce({
      ...response,
      error: "项目问答失败。",
    });

    act(() => {
      FakeEventSource.instances[0].emit("pi_event", {
        project_id: "project-1",
        event: "pi_event",
        message: "正在生成内容。",
        pi_type: "message_update",
      });
      FakeEventSource.instances[0].emit("project_chat_failed", {
        project_id: "project-1",
        event: "project_chat_failed",
        message: "项目问答失败。",
      });
    });

    await waitFor(() => {
      expect(result.current.projectChatError).toBe("项目问答失败。");
      expect(result.current.projectChatEvents).toHaveLength(0);
      expect(getProjectChat).toHaveBeenCalledTimes(2);
    });
  });

  it("sends trimmed input and clears transient state", async () => {
    vi.mocked(sendProjectChatMessage).mockResolvedValue({
      ...response,
      messages: [
        {
          role: "user",
          content: "项目入口在哪？",
          created_at: response.updated_at,
        },
      ],
    });
    const { result } = renderHook(() => useProjectChat("project-1"));
    await waitFor(() => expect(result.current.projectChat).toEqual(response));

    act(() => result.current.setProjectChatInput("  项目入口在哪？  "));
    await act(async () => result.current.sendProjectChat());

    expect(sendProjectChatMessage).toHaveBeenCalledWith(
      "project-1",
      "项目入口在哪？",
    );
    expect(result.current.projectChatInput).toBe("");
    expect(result.current.projectChat?.messages).toHaveLength(1);
  });

  it("does not restore stale chat after switching projects", async () => {
    let resolveFirst!: (value: ProjectChatResponse) => void;
    vi.mocked(getProjectChat)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({ ...response, project_id: "project-2" });
    const { result, rerender } = renderHook(
      ({ projectId }) => useProjectChat(projectId),
      { initialProps: { projectId: "project-1" } },
    );

    rerender({ projectId: "project-2" });
    await waitFor(() =>
      expect(result.current.projectChat?.project_id).toBe("project-2"),
    );
    await act(async () => resolveFirst(response));

    expect(result.current.projectChat?.project_id).toBe("project-2");
  });
});
