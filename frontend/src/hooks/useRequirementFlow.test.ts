// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmRequirement,
  getRequirementConversation,
  submitRequirementClarifications,
} from "../api/client";
import type {
  DraftClarificationAnswer,
  ProjectCanvasData,
  Requirement,
  RequirementClarification,
  RequirementConversation,
  RequirementConversationPrompt,
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
      ),
    );

    await act(async () => {
      await result.current.confirmRequirement(requirement);
    });

    expect(setProjectCanvas).toHaveBeenCalledWith(canvas);
    expect(observeRequirement).toHaveBeenCalledWith(requirement.id);
  });

  it("dismisses the prompt while continuing and resets it for another requirement", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const input = document.createElement("div");
    input.setAttribute("role", "combobox");
    input.setAttribute("contenteditable", "true");
    const card = document.createElement("div");
    card.dataset.chatCard = "requirement";
    card.append(input);
    document.body.append(card);

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
    expect(input).toHaveFocus();

    rerender({ activeRequirementId: "requirement-2" });
    await waitFor(() => {
      expect(result.current.dismissedPromptRequirementId).toBeNull();
    });
    card.remove();
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

  it("submits clarifications from the active prompt, not stale requirement.clarifications", async () => {
    const q1: RequirementClarification = {
      id: "q1",
      question: "范围",
      question_type: "single_choice",
      options: [
        { value: "small", label: "核心", description: "", recommended: true },
      ],
      answer: null,
    };
    const prompt: RequirementConversationPrompt = {
      type: "clarification",
      round: 1,
      questions: [q1],
    };
    const clarifyingConversation: RequirementConversation = {
      ...conversation,
      status: "clarifying",
      running: false,
      prompt,
    };
    vi.mocked(getRequirementConversation).mockResolvedValue(
      clarifyingConversation,
    );
    vi.mocked(submitRequirementClarifications).mockResolvedValue(canvas);

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
      expect(result.current.requirementConversation).toEqual(
        clarifyingConversation,
      ),
    );

    const answer: DraftClarificationAnswer = {
      selectedOptions: ["small"],
      customText: "",
    };
    act(() => {
      result.current.updateClarificationAnswer(q1, answer);
    });

    await act(async () => {
      await result.current.submitClarifications({
        ...requirement,
        status: "clarifying",
        clarifications: [],
      });
    });

    expect(submitRequirementClarifications).toHaveBeenCalledTimes(1);
    expect(submitRequirementClarifications).toHaveBeenCalledWith(
      requirement.id,
      [
        {
          clarification_id: "q1",
          selected_options: ["small"],
          custom_text: null,
        },
      ],
      prompt,
    );
  });
});
