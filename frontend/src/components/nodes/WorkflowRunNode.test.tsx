// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkflowEvents, resumeWorkflowRun } from "../../api/client";
import { RequirementTaskEventsProvider } from "../../contexts/RequirementTaskEventsContext";
import type {
  Requirement,
  StreamEvent,
  WorkflowSnapshot,
} from "../../types/api";
import WorkflowRunNode from "./WorkflowRunNode";

vi.mock("../../api/client", () => ({
  getWorkflowEvents: vi.fn(),
  resumeWorkflowRun: vi.fn(),
}));

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
    error: null,
    created_at: "2026-06-30T00:00:00Z",
    updated_at: "2026-06-30T00:00:00Z",
  };
}

function renderNode(
  events: StreamEvent[] = [],
  status: Requirement["status"] = "planning",
  workflowRun?: WorkflowSnapshot,
) {
  return render(
    <RequirementTaskEventsProvider requirementId="req-1" events={events}>
      <ReactFlowProvider>
        <WorkflowRunNode
          data={{
            kind: "workflow-run",
            requirement: requirement(status),
            workflowRun,
            actionError: null,
            onClose: vi.fn(),
          }}
        />
      </ReactFlowProvider>
    </RequirementTaskEventsProvider>,
  );
}

function workflow(status: WorkflowSnapshot["run"]["status"]): WorkflowSnapshot {
  return {
    run: {
      id: "run-1",
      requirement_id: "req-1",
      project_id: "current",
      status,
      change_spec: {
        intent: "让任务稳定完成",
        acceptance_scenarios: [
          {
            id: "scenario-1",
            given: "任务已开始",
            when: "执行流程",
            then: "用户看到完整结果",
          },
        ],
        explicit_constraints: [],
        non_goals: [],
      },
      design_notes: [],
      plan_summary: "执行行为切片",
      source_revision: 1,
      rescue_used: true,
      blocked_reason:
        status === "paused_technical" ? "checkpoint 协议失败" : null,
      paused_operation:
        status === "paused_technical" ? "review_checkpoint" : null,
      version: 1,
      created_at: "2026-07-13T00:00:00Z",
      updated_at: "2026-07-13T00:01:00Z",
    },
    work_items: [],
    dependencies: [],
    attempts: [],
    checkpoints: [],
    validations: [],
    findings: [],
    last_event_sequence: 21,
  };
}

describe("WorkflowRunNode", () => {
  beforeEach(() => {
    vi.mocked(getWorkflowEvents).mockResolvedValue({
      events: [],
      next_after: null,
    });
    vi.mocked(resumeWorkflowRun).mockResolvedValue(workflow("running"));
  });
  it("shows only current planning thinking and ignores tools and task events", () => {
    renderNode([
      {
        requirement_id: "req-1",
        event: "workflow_planning_started",
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
        event: "workflow_planning_started",
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
        event: "workflow_planning_started",
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

  it("marks the thinking scroll strip with nodrag and nowheel", () => {
    renderNode();
    const strip = document.querySelector(".nodrag.nowheel");
    expect(strip).toBeInTheDocument();
  });

  it("shows all 21 persisted events and the primary technical cause", async () => {
    vi.mocked(getWorkflowEvents).mockResolvedValue({
      events: Array.from({ length: 21 }, (_, index) => ({
        sequence: index + 1,
        run_id: "run-1",
        entity_type: index === 18 ? "validation" : "run",
        entity_id: `entity-${index + 1}`,
        event_type:
          index === 17
            ? "checkpoint.technical_failure"
            : index === 18
              ? "validation.completed"
              : index === 19
                ? "run.rescue_started"
                : index === 20
                  ? "run.paused_technical"
                  : `operation.${index + 1}`,
        payload:
          index === 20
            ? { operation: "review_checkpoint", reason: "checkpoint 协议失败" }
            : {},
        created_at: "2026-07-13T00:01:00Z",
      })),
      next_after: null,
    });

    renderNode([], "running", workflow("paused_technical"));

    expect(await screen.findByText("完整时间线 · 21 条")).toBeInTheDocument();
    expect(screen.getByText("审核技术失败")).toBeInTheDocument();
    expect(screen.getByText("仓库原生验证完成")).toBeInTheDocument();
    expect(screen.getByText("高级 Rescue 启动")).toBeInTheDocument();
    expect(screen.getByText("Primary cause")).toBeInTheDocument();
    expect(screen.getAllByText(/checkpoint 协议失败/).length).toBeGreaterThan(
      0,
    );
  });

  it("resumes only from the paused operation", async () => {
    renderNode([], "running", workflow("paused_technical"));

    fireEvent.click(screen.getByRole("button", { name: "从暂停位置恢复" }));
    await waitFor(() =>
      expect(resumeWorkflowRun).toHaveBeenCalledWith("run-1"),
    );
    expect(await screen.findByText("执行中")).toBeInTheDocument();
  });
});
