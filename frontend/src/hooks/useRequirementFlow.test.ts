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

  it("ignores SSE events that do not belong to the observed requirement", async () => {
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
      source.emit("execution_started", {
        requirement_id: requirement.id,
        event: "execution_started",
        message: "started",
      });
    });

    await waitFor(() => {
      expect(result.current.requirementStreamEvents).toHaveLength(1);
      // loadProjectCanvas is intentionally NOT called from the SSE handler;
      // canvas updates are handled by the 2500ms setInterval poll to avoid
      // rebuilding the DAG on every task event (performance fix).
      expect(loadProjectCanvas).not.toHaveBeenCalled();
      expect(getRequirementConversation).toHaveBeenCalledWith(requirement.id);
    });
  });
});
