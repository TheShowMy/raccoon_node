// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmRequirement,
  createRequirement,
  getRequirementConversation,
} from "../api/client";
import type {
  ProjectCanvasData,
  Requirement,
  RequirementConversation,
  StreamEvent,
} from "../types/api";
import { useRequirementFlow } from "./useRequirementFlow";

vi.mock("../api/client", () => ({
  createRequirement: vi.fn(),
  appendRequirementMessage: vi.fn(),
  getRequirementConversation: vi.fn(),
  submitRequirementClarifications: vi.fn(),
  confirmRequirement: vi.fn(),
  retryRequirementAnalysis: vi.fn(),
  requirementConversationWebSocketUrl: (id: string) => `ws://test/${id}`,
}));

const now = "2026-06-25T00:00:00Z";
const requirement: Requirement = {
  id: "requirement-1",
  project_id: "project-1",
  title: "测试需求",
  original_message: "测试需求",
  status: "draft_ready",
  messages: [],
  clarification_round: 0,
  clarifications: [],
  draft: null,
  execution_plan: null,
  pi_session_file: null,
  error: null,
  created_at: now,
  updated_at: now,
};
const canvas: ProjectCanvasData = {
  project: {
    id: "project-1",
    name: "Project",
    git_url: "https://example.com/project.git",
    local_path: "/tmp/project",
    created_at: now,
    updated_at: now,
  },
  active_requirement: null,
  queued_requirements: [{ ...requirement, status: "planning" }],
  completed_requirements: [],
};
const conversation: RequirementConversation = {
  id: requirement.id,
  project_id: requirement.project_id,
  title: requirement.title,
  status: "planning",
  running: true,
  items: [],
  prompt: null,
  error: null,
  updated_at: now,
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

  emit(type: string, payload: StreamEvent) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
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

  emit(event: { type: string; payload: Record<string, unknown> }) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  }
}

describe("useRequirementFlow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    FakeEventSource.instances = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.mocked(getRequirementConversation).mockResolvedValue(conversation);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects the confirmed requirement for continued observation", async () => {
    vi.mocked(confirmRequirement).mockResolvedValue(canvas);
    const beforeConfirmation: RequirementConversation = {
      ...conversation,
      prompt: {
        type: "confirmation",
        draft: {
          title: "测试需求",
          summary: "确认前草案",
          acceptance_criteria: ["保留完整记录"],
        },
        prompt_id: "prompt-1",
        revision: 1,
      },
    };
    const afterConfirmation: RequirementConversation = {
      ...conversation,
      running: false,
      prompt: null,
    };
    vi.mocked(getRequirementConversation).mockResolvedValue(beforeConfirmation);
    const setProjectCanvas = vi.fn();
    const observeRequirement = vi.fn();
    const { result } = renderHook(() =>
      useRequirementFlow(
        "project-1",
        requirement.id,
        null,
        setProjectCanvas,
        vi.fn(),
        observeRequirement,
        [requirement],
      ),
    );
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() =>
      expect(result.current.requirementConversation?.prompt).not.toBeNull(),
    );
    vi.mocked(getRequirementConversation).mockResolvedValueOnce(
      afterConfirmation,
    );

    await act(async () => {
      await result.current.confirmRequirement(requirement);
    });

    expect(setProjectCanvas).toHaveBeenCalledWith(canvas);
    expect(observeRequirement).toHaveBeenCalledWith(requirement.id);
    await waitFor(() => {
      expect(result.current.requirementTimeline).toHaveLength(1);
      expect(
        result.current.requirementTimeline[0].conversation?.prompt,
      ).toBeNull();
    });
  });

  it("opens the accepted requirement socket before the canvas refresh completes", async () => {
    const activeCanvas: ProjectCanvasData = {
      ...canvas,
      active_requirement: { ...requirement, status: "analyzing" },
      queued_requirements: [],
    };
    const order: string[] = [];
    vi.mocked(createRequirement).mockResolvedValue({
      accepted: true,
      requirement_id: requirement.id,
    });
    let resolveCanvas!: (data: ProjectCanvasData) => void;
    const loadProjectCanvas = vi.fn(() => {
      order.push("canvas-started");
      return new Promise<ProjectCanvasData>((resolve) => {
        resolveCanvas = resolve;
      });
    });
    const setProjectCanvas = vi.fn();
    const { result } = renderHook(() =>
      useRequirementFlow(
        "project-1",
        null,
        null,
        setProjectCanvas,
        loadProjectCanvas,
        vi.fn(),
      ),
    );
    const attachments = {
      references: [{ path: "README.md" }],
      images: [
        {
          path: "context.png",
          name: "context.png",
          mime_type: "image/png",
          size_bytes: 10,
        },
      ],
    };

    let accepted = false;
    let startPromise!: Promise<boolean>;
    act(() => {
      startPromise = result.current.startRequirement(
        "重写登录流程",
        attachments,
      );
    });

    await waitFor(() => {
      expect(result.current.openingRequirementId).toBe(requirement.id);
      expect(FakeWebSocket.instances.at(-1)?.url).toBe(
        `ws://test/${requirement.id}`,
      );
    });
    await act(async () => {
      resolveCanvas(activeCanvas);
      accepted = await startPromise;
    });

    expect(accepted).toBe(true);
    expect(createRequirement).toHaveBeenCalledWith("project-1", {
      message: "重写登录流程",
      ...attachments,
    });
    expect(order).toEqual(["canvas-started"]);
    expect(result.current.openingRequirementId).toBe(requirement.id);
    expect(result.current.requirementTimeline).toEqual([
      expect.objectContaining({
        requirementId: requirement.id,
        requirement: null,
        opening: true,
      }),
    ]);
    expect(setProjectCanvas).toHaveBeenCalledWith(activeCanvas);
  });

  it("uses a stable context instruction for a command without description", async () => {
    vi.mocked(createRequirement).mockResolvedValue({
      accepted: true,
      requirement_id: requirement.id,
    });
    const loadProjectCanvas = vi.fn().mockResolvedValue(canvas);
    const { result } = renderHook(() =>
      useRequirementFlow(
        "project-1",
        null,
        null,
        vi.fn(),
        loadProjectCanvas,
        vi.fn(),
      ),
    );

    await act(async () => {
      await result.current.startRequirement(null, {
        references: [],
        images: [],
      });
    });

    expect(createRequirement).toHaveBeenCalledWith("project-1", {
      message: "请基于当前项目对话上下文生成需求。",
      references: [],
      images: [],
    });
  });

  it("loads persisted conversations lazily once and removes only deleted branches", async () => {
    const first = {
      ...requirement,
      id: "requirement-1",
      status: "completed" as const,
    };
    const second = {
      ...requirement,
      id: "requirement-2",
      status: "completed" as const,
    };
    vi.mocked(getRequirementConversation).mockImplementation(async (id) => ({
      ...conversation,
      id,
      title: id,
      status: "completed",
      running: false,
    }));
    const { result, rerender } = renderHook(
      ({ requirements }) =>
        useRequirementFlow(
          "project-1",
          null,
          null,
          vi.fn(),
          vi.fn(),
          vi.fn(),
          requirements,
        ),
      { initialProps: { requirements: [first, second] } },
    );

    await waitFor(() => {
      expect(result.current.requirementTimeline).toHaveLength(2);
      expect(
        result.current.requirementTimeline.filter((item) => item.conversation),
      ).toHaveLength(1);
      expect(result.current.hasOlderRequirementHistory).toBe(true);
    });
    const stableFirstBranch = result.current.requirementTimeline.find(
      (item) => item.conversation,
    );
    await act(async () => {
      expect(await result.current.loadOlderRequirementHistory()).toBe(true);
    });
    await waitFor(() => {
      expect(
        result.current.requirementTimeline.every((item) => item.conversation),
      ).toBe(true);
      expect(result.current.hasOlderRequirementHistory).toBe(false);
    });
    expect(
      result.current.requirementTimeline.find(
        (item) => item.requirementId === stableFirstBranch?.requirementId,
      ),
    ).toBe(stableFirstBranch);
    expect(getRequirementConversation).toHaveBeenCalledTimes(2);

    rerender({ requirements: [first, second] });
    await Promise.resolve();
    expect(getRequirementConversation).toHaveBeenCalledTimes(2);

    rerender({ requirements: [second] });
    await waitFor(() =>
      expect(
        result.current.requirementTimeline.map((item) => item.requirementId),
      ).toEqual([second.id]),
    );
    expect(getRequirementConversation).toHaveBeenCalledTimes(2);
  });

  it("isolates a historical conversation load failure to its branch", async () => {
    const first = {
      ...requirement,
      id: "requirement-ok",
      status: "completed" as const,
    };
    const second = {
      ...requirement,
      id: "requirement-failed",
      status: "completed" as const,
    };
    vi.mocked(getRequirementConversation).mockImplementation(async (id) => {
      if (id === second.id) throw new Error("历史记录不可用");
      return { ...conversation, id, running: false, status: "completed" };
    });
    const { result } = renderHook(() =>
      useRequirementFlow("project-1", null, null, vi.fn(), vi.fn(), vi.fn(), [
        first,
        second,
      ]),
    );

    await waitFor(() => {
      expect(
        result.current.requirementTimeline.find(
          (item) => item.requirementId === first.id,
        )?.conversation,
      ).not.toBeNull();
      expect(result.current.hasOlderRequirementHistory).toBe(true);
    });
    await act(async () => {
      expect(await result.current.loadOlderRequirementHistory()).toBe(false);
    });
    await waitFor(() => {
      expect(
        result.current.requirementTimeline.find(
          (item) => item.requirementId === second.id,
        )?.error,
      ).toBe("历史记录不可用");
    });
    expect(result.current.requirementError).toBeNull();
  });

  it("dismisses the prompt while continuing and resets it for another requirement", async () => {
    const { result, rerender } = renderHook(
      ({ activeRequirementId }) =>
        useRequirementFlow(
          "project-1",
          activeRequirementId,
          null,
          vi.fn(),
          vi.fn(),
          vi.fn(),
        ),
      { initialProps: { activeRequirementId: requirement.id } },
    );

    act(() => {
      result.current.continueEditingRequirement(requirement);
    });

    expect(result.current.dismissedPromptRequirementId).toBe(requirement.id);

    rerender({ activeRequirementId: "requirement-2" });
    await waitFor(() => {
      expect(result.current.dismissedPromptRequirementId).toBeNull();
    });
  });

  it("keeps live process events when a running conversation snapshot is reconciled", async () => {
    const { result } = renderHook(() =>
      useRequirementFlow(
        "project-1",
        requirement.id,
        null,
        vi.fn(),
        vi.fn(),
        vi.fn(),
      ),
    );
    const socket = FakeWebSocket.instances[0];

    act(() => socket.open());
    await waitFor(() =>
      expect(result.current.requirementConversation).toEqual(conversation),
    );

    act(() =>
      socket.emit({
        type: "agent.event",
        payload: {
          requirement_id: requirement.id,
          pi_type: "tool_execution_start",
          event: {
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "read",
          },
        },
      }),
    );
    expect(
      result.current.requirementStreamEvents.map((event) => event.event),
    ).toEqual(["agent.event"]);

    vi.mocked(getRequirementConversation).mockResolvedValueOnce({
      ...conversation,
      running: true,
    });
    act(() =>
      socket.emit({
        type: "snapshot.changed",
        payload: { requirement_id: requirement.id },
      }),
    );

    await waitFor(() =>
      expect(result.current.requirementConversation?.running).toBe(true),
    );
    expect(
      result.current.requirementStreamEvents.map((event) => event.event),
    ).toEqual(["agent.event", "snapshot.changed"]);
  });

  it("keeps DAG summary events out of memory and refreshes on task boundaries", async () => {
    const loadProjectCanvas = vi.fn().mockResolvedValue(canvas);
    const { result } = renderHook(() =>
      useRequirementFlow(
        "project-1",
        null,
        requirement.id,
        vi.fn(),
        loadProjectCanvas,
        vi.fn(),
      ),
    );
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe(
      `/api/requirements/${requirement.id}/events?include_pi_events=false`,
    );

    act(() => {
      source.emit("execution_started", {
        requirement_id: "other-requirement",
        event: "execution_started",
        message: "other",
      });
    });
    expect(result.current.requirementStreamEvents).toEqual([]);
    expect(loadProjectCanvas).not.toHaveBeenCalled();

    act(() => {
      for (let index = 0; index < 1_000; index += 1) {
        source.emit("pi_event", {
          requirement_id: requirement.id,
          task_id: "task-1",
          event: "pi_event",
          message: `event-${index}`,
        });
      }
      source.emit("execution_task_started", {
        requirement_id: requirement.id,
        task_id: "task-1",
        event: "execution_task_started",
        message: "started",
      });
    });

    await waitFor(() => {
      expect(result.current.requirementStreamEvents).toEqual([]);
      expect(loadProjectCanvas).toHaveBeenCalledTimes(1);
      expect(loadProjectCanvas).toHaveBeenCalledWith(
        "project-1",
        requirement.id,
      );
      expect(getRequirementConversation).not.toHaveBeenCalled();
    });
  });
});
