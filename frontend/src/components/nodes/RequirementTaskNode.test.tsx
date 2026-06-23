// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RequirementTaskNode from "./RequirementTaskNode";
import type { RequirementExecutionTask, StreamEvent } from "../../types/api";

function task(
  overrides: Partial<RequirementExecutionTask> = {},
): RequirementExecutionTask {
  return {
    id: "task-1",
    title: "实现登录",
    description: "补齐登录流程",
    depends_on: [],
    kind: "implementation",
    model_tier: "medium",
    timeout_seconds: 2700,
    pi_session_file: null,
    branch_name: "rn/req/task-1",
    worktree_path: "/tmp/data/projects/p1/worktrees/task-1",
    commit_sha: "abcdef1234567890",
    review_for: null,
    review_angle: null,
    review_status: "pending",
    attempt: 1,
    last_review_feedback: null,
    pull_request_url: "https://github.com/acme/repo/pull/1",
    merged_into: "main",
    cleanup_summary: "已清理 worktree 1 个",
    execution_warning: null,
    trace: {
      type: "pi_trace",
      version: 1,
      trace: {
        thinking: "历史执行思考",
        output: "",
        tools: [],
        statuses: [],
      },
    },
    status: "completed",
    target_files: ["src/main.rs"],
    result_summary: "登录已完成",
    error: null,
    ...overrides,
  };
}

function renderNode({
  nodeTask = task(),
  nodeRole,
  reviews = [],
  streamEvents = [],
}: {
  nodeTask?: RequirementExecutionTask;
  nodeRole?:
    | "group"
    | "code"
    | "review_summary"
    | "review_sub_agent"
    | "external";
  reviews?: RequirementExecutionTask[];
  streamEvents?: StreamEvent[];
} = {}) {
  return render(
    <RequirementTaskNode
      data={{
        kind: "requirement-task",
        nodeRole,
        requirementId: "req-1",
        task: nodeTask,
        reviews,
        streamEvents,
        busy: false,
        onRetryFailedNode: vi.fn(),
        onRetryFromNode: vi.fn(),
        onRerunReview: vi.fn(),
      }}
    />,
  );
}

describe("RequirementTaskNode", () => {
  it("renders a fixed code node without embedded review cards", () => {
    const review = task({
      id: "review-task-1",
      title: "审核登录",
      kind: "review_sub_agent",
      status: "completed",
      review_for: "task-1",
      review_angle: "安全",
      last_review_feedback: "通过",
      pull_request_url: null,
      merged_into: null,
      cleanup_summary: null,
    });

    const { container } = renderNode({ nodeRole: "code", reviews: [review] });

    expect(screen.getByText("代码节点")).toBeInTheDocument();
    expect(container.querySelector(".task-node--code")).not.toBeNull();
    expect(container.querySelector(".task-node__mini-card--review")).toBeNull();
    expect(container.querySelector(".task-node__mini-arrow")).toBeNull();
    expect(container).toHaveTextContent("登录已完成");
    expect(container).not.toHaveTextContent("rn/req/task-1");
    expect(container).not.toHaveTextContent(
      "https://github.com/acme/repo/pull/1",
    );
    expect(container).not.toHaveTextContent("执行失败");
    expect(screen.queryByRole("button", { name: "从此恢复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重跑" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    const dialog = document.body.querySelector("dialog");
    expect(container.querySelector("dialog")).toBeNull();
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByText("任务描述")).toBeInTheDocument();
    expect(screen.getByText("节点交互")).toBeInTheDocument();
    expect(screen.getByText("执行过程")).toBeInTheDocument();
    expect(screen.getByText("补齐登录流程")).toBeInTheDocument();
    expect(screen.getByText("思考过程")).toBeInTheDocument();

    const details = document.body.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("基础信息"));

    expect(within(details!).getByText("分支")).toBeInTheDocument();
    expect(within(details!).getByText("rn/req/task-1")).toBeInTheDocument();
    expect(within(details!).getByText("abcdef1234567890")).toBeInTheDocument();
    expect(
      within(details!).getByText("https://github.com/acme/repo/pull/1"),
    ).toBeInTheDocument();
    expect(within(details!).getByText("安全：通过")).toBeInTheDocument();

    fireEvent.click(dialog!);
    expect(document.body.querySelector("dialog")).toBeNull();
  });

  it("only shows recovery actions for failed or rejected states", () => {
    const failedTask = task({
      status: "failed",
      error: "执行失败",
    });
    const rejectedReview = task({
      id: "review-task-1",
      kind: "review",
      status: "rejected",
      review_for: "task-1",
      review_angle: "安全",
      last_review_feedback: "需要补充权限检查",
    });

    const { unmount } = renderNode({
      nodeTask: failedTask,
      nodeRole: "code",
      reviews: [rejectedReview],
    });

    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "从此恢复" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重跑" })).toBeNull();
    unmount();

    renderNode({ nodeTask: rejectedReview, nodeRole: "review_sub_agent" });
    expect(screen.getByRole("button", { name: "重跑" })).toBeInTheDocument();
  });

  it("marks group, code, and review nodes with task status classes", () => {
    const { container, unmount } = renderNode({
      nodeRole: "group",
      nodeTask: task({ status: "pending" }),
    });

    expect(container.querySelector(".task-node--group")).toHaveClass(
      "task-node--status-pending",
    );
    unmount();

    const code = renderNode({
      nodeRole: "code",
      nodeTask: task({ status: "running" }),
    });
    expect(code.container.querySelector(".task-node--code")).toHaveClass(
      "task-node--status-running",
    );
    code.unmount();

    const review = renderNode({
      nodeRole: "review_sub_agent",
      nodeTask: task({ status: "completed" }),
    });
    expect(
      review.container.querySelector(".task-node--review_sub_agent"),
    ).toHaveClass("task-node--status-completed");
  });

  it("shows execution warning on node and detail dialog", () => {
    renderNode({
      nodeRole: "code",
      nodeTask: task({
        execution_warning:
          "未产生新提交：前置节点已实现。按 no-op 完成并进入审核。",
      }),
    });

    expect(screen.getByText(/未产生新提交/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText("执行提示")).toBeInTheDocument();
    expect(screen.getAllByText(/前置节点已实现/).length).toBeGreaterThan(0);
  });

  it("shows live pi events for the current task before historical trace", () => {
    renderNode({
      streamEvents: [
        {
          requirement_id: "req-1",
          task_id: "other-task",
          event: "pi_event",
          message: "其他任务",
          pi_type: "message_update",
          payload: {
            assistantMessageEvent: {
              type: "thinking_delta",
              delta: "其他任务思考",
            },
          },
        },
        {
          requirement_id: "req-1",
          task_id: "task-1",
          event: "pi_event",
          message: "当前任务",
          pi_type: "message_update",
          payload: {
            assistantMessageEvent: {
              type: "thinking_delta",
              delta: "实时执行思考",
            },
          },
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(screen.getByText("实时执行思考")).toBeInTheDocument();
    expect(screen.queryByText("其他任务思考")).toBeNull();
  });
});
