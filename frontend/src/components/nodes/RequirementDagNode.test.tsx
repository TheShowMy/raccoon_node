// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import { RequirementTaskEventsProvider } from "../../contexts/RequirementTaskEventsContext";
import type { Requirement, StreamEvent } from "../../types/api";
import RequirementDagNode from "./RequirementDagNode";

function requirement(status: Requirement["status"] = "planning"): Requirement {
  return {
    id: "req-1",
    project_id: "current",
    title: "实现需求",
    original_message: "实现需求",
    origin: "standalone",
    status,
    messages: [],
    clarification_round: 0,
    clarifications: [],
    draft: null,
    execution_plan:
      status === "planning"
        ? null
        : { summary: "不应显示的计划摘要", tasks: [] },
    error: null,
    created_at: "2026-06-30T00:00:00Z",
    updated_at: "2026-06-30T00:00:00Z",
  };
}

function renderNode(
  events: StreamEvent[] = [],
  status: Requirement["status"] = "planning",
) {
  return render(
    <RequirementTaskEventsProvider requirementId="req-1" events={events}>
      <ReactFlowProvider>
        <RequirementDagNode
          data={{
            kind: "requirement-dag",
            requirement: requirement(status),
            actionError: null,
            onClose: vi.fn(),
          }}
        />
      </ReactFlowProvider>
    </RequirementTaskEventsProvider>,
  );
}

describe("RequirementDagNode", () => {
  it("shows only current planning thinking and ignores tools and task events", () => {
    renderNode([
      {
        requirement_id: "req-1",
        event: "execution_planning_started",
        message: "",
      },
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "旧内容",
          },
        },
      },
      {
        requirement_id: "req-1",
        event: "execution_planning_started",
        message: "",
      },
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "正在",
          },
        },
      },
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "",
        pi_type: "tool_execution_start",
        payload: { toolName: "read" },
      },
      {
        requirement_id: "req-1",
        task_id: "task-1",
        event: "pi_event",
        message: "",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "任务内容",
          },
        },
      },
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "拆分",
          },
        },
      },
    ]);

    expect(screen.getByText("思考")).toBeInTheDocument();
    expect(screen.getByText("正在拆分")).toBeInTheDocument();
    expect(screen.queryByText(/旧内容|任务内容|read/)).toBeNull();
  });

  it("shows a placeholder until thinking arrives", () => {
    renderNode([
      {
        requirement_id: "req-1",
        event: "execution_planning_started",
        message: "",
      },
    ]);

    expect(screen.getByText("思考中…")).toBeInTheDocument();
  });

  it("shows thinking received after opening an in-progress plan", () => {
    renderNode([
      {
        requirement_id: "req-1",
        event: "pi_event",
        message: "",
        pi_type: "message_update",
        payload: {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "继续拆分任务",
          },
        },
      },
    ]);

    expect(screen.getByText("继续拆分任务")).toBeInTheDocument();
  });

  it("hides the strip and plan summary after planning", () => {
    renderNode([], "plan_ready");

    expect(screen.queryByText("思考")).toBeNull();
    expect(screen.queryByText("不应显示的计划摘要")).toBeNull();
  });
});
