// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmRequirement,
  createRequirementBranch,
  getRequirementConversation,
  submitRequirementClarifications,
} from "../api/client";
import type {
  ProjectCanvasData,
  Requirement,
  RequirementConversation,
  StreamEvent,
} from "../types/api";
import { useRequirementFlow } from "./useRequirementFlow";

vi.mock("../api/client", () => ({
  createRequirementBranch: vi.fn(),
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
  title: "测试需求",
  origin: "standalone",
  status: "draft_ready",
  messages: [],
  clarification_round: 0,
  clarifications: [],
  draft: null,
  error: null,
  created_at: now,
  updated_at: now,
};
const canvas: ProjectCanvasData = {
  project: {
    name: "Project",
    git_url: "https://example.com/project.git",
    local_path: "/tmp/project",
  },
  active_requirement: null,
  queued_requirements: [{ ...requirement, status: "planning" }],
  completed_requirements: [],
};
const conversation: RequirementConversation = {
  id: requirement.id,
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
    vi.mocked(createRequirementBranch).mockResolvedValue({
      accepted: true,
      requirement_id: requirement.id,
    });
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
          intent: "测试需求",
          acceptance_scenarios: [
            {
              id: "scenario-1",
              given: "需求已确认",
              when: "执行工作流",
              then: "保留完整记录",
            },
          ],
          explicit_constraints: [],
          non_goals: [],
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
    await waitFor(() =>
      expect(result.current.requirementConversation?.prompt).toBeNull(),
    );
  });

  it("submits clarification answers from conversation prompt even if requirement.clarifications is stale", async () => {
    vi.mocked(submitRequirementClarifications).mockResolvedValue(canvas);
    const clarifyingConversation: RequirementConversation = {
      ...conversation,
      status: "clarifying",
      running: false,
      prompt: {
        type: "clarification",
        round: 1,
        prompt_id: "prompt-1",
        revision: 1,
        questions: [
          {
            id: "q1",
            question: "范围？",
            question_type: "single_choice",
            options: [
              {
                value: "current",
                label: "当前页",
                description: "只导出当前页",
                recommended: false,
              },
              {
                value: "all",
                label: "全部",
                description: "导出全部数据",
                recommended: true,
              },
            ],
            answer: null,
          },
        ],
      },
    };
    vi.mocked(getRequirementConversation).mockResolvedValue(
      clarifyingConversation,
    );
    const setProjectCanvas = vi.fn();
    const { result } = renderHook(() =>
      useRequirementFlow(
        requirement.id,
        null,
        setProjectCanvas,
        vi.fn(),
        vi.fn(),
        [requirement],
      ),
    );
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() =>
      expect(result.current.requirementConversation?.prompt).not.toBeNull(),
    );

    const staleRequirement: Requirement = {
      ...requirement,
      status: "clarifying",
      clarifications: [],
    };

    await act(async () => {
      await result.current.submitClarifications(staleRequirement, {
        q1: { selectedOptions: ["all"], customText: "" },
      });
    });

    await waitFor(() =>
      expect(submitRequirementClarifications).toHaveBeenCalledTimes(1),
    );
    expect(submitRequirementClarifications).toHaveBeenCalledWith(
      staleRequirement.id,
      [
        {
          clarification_id: "q1",
          selected_options: ["all"],
          custom_text: null,
        },
      ],
      clarifyingConversation.prompt,
    );
  });

  it("opens the accepted requirement socket before the canvas refresh completes", async () => {
    const activeCanvas: ProjectCanvasData = {
      ...canvas,
      active_requirement: { ...requirement, status: "analyzing" },
      queued_requirements: [],
    };
    const order: string[] = [];
    vi.mocked(createRequirementBranch).mockResolvedValue({
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
    expect(createRequirementBranch).toHaveBeenCalledWith({
      message: "重写登录流程",
      ...attachments,
    });
    expect(order).toEqual(["canvas-started"]);
    expect(result.current.openingRequirementId).toBe(requirement.id);
    expect(setProjectCanvas).toHaveBeenCalledWith(activeCanvas);
  });

  it("starts a requirement branch with a default message when no supplement is given", async () => {
    const loadProjectCanvas = vi.fn().mockResolvedValue(canvas);
    const { result } = renderHook(() =>
      useRequirementFlow(null, null, vi.fn(), loadProjectCanvas, vi.fn()),
    );

    await act(async () => {
      await result.current.startRequirement("", {
        references: [],
        images: [],
      });
    });

    expect(createRequirementBranch).toHaveBeenCalledWith({
      message: "基于上文整理需求",
      references: [],
      images: [],
    });
  });

  it("loads the active requirement conversation and ignores unrelated requirements", async () => {
    const active = {
      ...requirement,
      id: "active-1",
      status: "analyzing" as const,
    };
    const other = {
      ...requirement,
      id: "other-1",
      status: "completed" as const,
    };
    vi.mocked(getRequirementConversation).mockImplementation(async (id) => ({
      ...conversation,
      id,
      title: id,
      status: id === active.id ? "analyzing" : "completed",
      running: id === active.id,
    }));
    const { result } = renderHook(() =>
      useRequirementFlow(active.id, null, vi.fn(), vi.fn(), vi.fn(), [
        active,
        other,
      ]),
    );

    await waitFor(() =>
      expect(result.current.requirementConversation?.id).toBe(active.id),
    );
    expect(getRequirementConversation).toHaveBeenCalledWith(active.id);
    expect(getRequirementConversation).not.toHaveBeenCalledWith(other.id);
  });

  it("clears the opening requirement once it appears in the canvas", async () => {
    const { result, rerender } = renderHook(
      ({ requirements }) =>
        useRequirementFlow(null, null, vi.fn(), vi.fn(), vi.fn(), requirements),
      { initialProps: { requirements: [] as Requirement[] } },
    );

    await act(async () => {
      await result.current.startRequirement("新建需求", {
        references: [],
        images: [],
      });
    });
    expect(result.current.openingRequirementId).toBe(requirement.id);

    rerender({ requirements: [requirement] });
    await waitFor(() => expect(result.current.openingRequirementId).toBeNull());
  });

  it("dismisses the prompt while continuing and resets it for another requirement", async () => {
    const { result, rerender } = renderHook(
      ({ activeRequirementId }) =>
        useRequirementFlow(
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
      useRequirementFlow(requirement.id, null, vi.fn(), vi.fn(), vi.fn()),
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

  it("keeps workflow summary events out of memory and refreshes on work-item boundaries", async () => {
    const loadProjectCanvas = vi.fn().mockResolvedValue(canvas);
    const { result } = renderHook(() =>
      useRequirementFlow(
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
      source.emit("workflow_started", {
        requirement_id: "other-requirement",
        event: "workflow_started",
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
      source.emit("work_item_attempt_started", {
        requirement_id: requirement.id,
        task_id: "task-1",
        event: "work_item_attempt_started",
        message: "started",
      });
    });

    await waitFor(() => {
      expect(result.current.requirementStreamEvents).toEqual([]);
      expect(loadProjectCanvas).toHaveBeenCalledTimes(1);
      expect(loadProjectCanvas).toHaveBeenCalledWith(requirement.id);
      expect(getRequirementConversation).not.toHaveBeenCalled();
    });
  });
});
