// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmRequirement, getRequirementConversation } from "../api/client";
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

describe("useRequirementFlow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
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
    const textarea = document.createElement("textarea");
    const card = document.createElement("div");
    card.dataset.chatCard = "requirement";
    card.append(textarea);
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
    expect(textarea).toHaveFocus();

    rerender({ activeRequirementId: "requirement-2" });
    await waitFor(() => {
      expect(result.current.dismissedPromptRequirementId).toBeNull();
    });
    card.remove();
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
