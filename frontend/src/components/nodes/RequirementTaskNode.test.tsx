// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RequirementTaskNode from "./RequirementTaskNode";
import type { RequirementExecutionTask, StreamEvent } from "../../types/api";
import { RequirementTaskEventsProvider } from "../../contexts/RequirementTaskEventsContext";

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
    execution_failure_count: 0,
    review_rejection_count: 0,
    recovery_stage: "none",
    failure_summary: null,
    recovery_guidance: null,
    high_tier_execution_used: false,
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
  collapsed = false,
  busy = false,
  onRecoverTaskGroup = vi.fn(),
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
  collapsed?: boolean;
  busy?: boolean;
  onRecoverTaskGroup?: (requirementId: string, taskId: string) => Promise<void>;
} = {}) {
  const renderWithEvents = (events: StreamEvent[]) => (
    <RequirementTaskEventsProvider requirementId="req-1" events={events}>
      <RequirementTaskNode
        data={{
          kind: "requirement-task",
          nodeRole,
          requirementId: "req-1",
          task: nodeTask,
          reviews,
          busy,
          collapsed,
          onRecoverTaskGroup,
        }}
      />
    </RequirementTaskEventsProvider>
  );
  const view = render(renderWithEvents(streamEvents));
  return {
    ...view,
    updateEvents: (events: StreamEvent[]) =>
      view.rerender(renderWithEvents(events)),
  };
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

  it("does not show recovery actions on child nodes", () => {
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

    expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "从此恢复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重跑" })).toBeNull();
    unmount();

    renderNode({
      nodeTask: rejectedReview,
      nodeRole: "review_sub_agent",
    });
    expect(screen.queryByRole("button", { name: "重跑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "从此恢复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("shows one recovery action on a failed group and targets the group task", () => {
    const failedReview = task({
      id: "review-task-1",
      kind: "review_sub_agent",
      status: "failed",
      review_for: "task-1",
      review_angle: "安全",
      error: "审核执行失败",
    });
    const onRecoverTaskGroup = vi.fn().mockResolvedValue(undefined);

    renderNode({
      nodeTask: task(),
      nodeRole: "group",
      reviews: [failedReview],
      collapsed: true,
      onRecoverTaskGroup,
    });

    expect(screen.getByText("失败")).toBeInTheDocument();
    const recover = screen.getByRole("button", { name: "恢复" });
    fireEvent.click(recover);
    expect(onRecoverTaskGroup).toHaveBeenCalledWith("req-1", "task-1");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重跑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "从此恢复" })).toBeNull();
  });

  it("shows one recovery action on a failed standalone task", () => {
    renderNode({
      nodeTask: task({ kind: "branch_merge", status: "failed" }),
      nodeRole: "external",
      busy: true,
    });

    expect(screen.getByRole("button", { name: "恢复" })).toBeDisabled();
  });

  it("does not show recovery for rejected reviews", () => {
    renderNode({
      nodeRole: "group",
      collapsed: true,
      reviews: [
        task({
          id: "review-task-1",
          kind: "review_sub_agent",
          status: "rejected",
          review_for: "task-1",
        }),
      ],
    });

    expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
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

  it("shows recovery state on the group and recovery details in the dialog", () => {
    const recoveringTask = task({
      status: "failed",
      error: "执行命令超时",
      execution_failure_count: 2,
      review_rejection_count: 1,
      recovery_stage: "high_tier_execution",
      failure_summary: "连续两次执行未完成",
      recovery_guidance: "切换高档模型后重新执行",
      high_tier_execution_used: true,
    });
    const group = renderNode({
      nodeRole: "group",
      nodeTask: recoveringTask,
    });

    expect(screen.getByText("高档模型接管")).toBeInTheDocument();
    group.unmount();

    renderNode({ nodeRole: "code", nodeTask: recoveringTask });
    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(screen.getByText("恢复信息")).toBeInTheDocument();
    expect(screen.getByText("执行命令超时")).toBeInTheDocument();
    expect(screen.getByText("连续两次执行未完成")).toBeInTheDocument();
    expect(screen.getByText("切换高档模型后重新执行")).toBeInTheDocument();
    expect(screen.getByText("高档（恢复升级）")).toBeInTheDocument();
    expect(screen.getByText("执行失败次数").nextSibling).toHaveTextContent("2");
    expect(screen.getByText("审核拒绝次数").nextSibling).toHaveTextContent("1");
  });

  it("shows trace usage while keeping old traces without usage clean", () => {
    const oldTrace = renderNode();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.queryByText("会话统计")).toBeNull();
    oldTrace.unmount();

    renderNode({
      nodeTask: task({
        trace: {
          type: "pi_trace",
          version: 1,
          trace: {
            thinking: "带统计的历史执行",
            output: "",
            tools: [],
            statuses: [],
            usage: {
              sessionReused: true,
              callCount: 3,
              input: 1500,
              output: 320,
              cacheRead: 1000,
              cacheWrite: 240,
              context: {
                tokens: 12000,
                window: 128000,
                percent: 9.375,
              },
            },
          },
        },
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(screen.getByText("会话统计")).toBeInTheDocument();
    expect(screen.getByText("会话是否复用").nextSibling).toHaveTextContent(
      "是",
    );
    expect(screen.getByText("累计调用数").nextSibling).toHaveTextContent(
      "3 次",
    );
    expect(screen.getByText("input").nextSibling).toHaveTextContent("1,500");
    expect(screen.getByText("output").nextSibling).toHaveTextContent("320");
    expect(screen.getByText("cacheRead").nextSibling).toHaveTextContent(
      "1,000",
    );
    expect(screen.getByText("cacheWrite").nextSibling).toHaveTextContent("240");
    expect(screen.getByText("缓存命中率").nextSibling).toHaveTextContent(
      "40.0%",
    );
    expect(screen.getByText("context tokens").nextSibling).toHaveTextContent(
      "12,000",
    );
    expect(screen.getByText("context window").nextSibling).toHaveTextContent(
      "128,000",
    );
    expect(screen.getByText("context percent").nextSibling).toHaveTextContent(
      "9.4%",
    );
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

  it("does not read task events until the detail is open", () => {
    const taskIdRead = vi.fn(() => "task-1");
    const event = {
      requirement_id: "req-1",
      get task_id() {
        return taskIdRead();
      },
      event: "pi_event",
      message: "当前任务",
      pi_type: "message_update",
      payload: {
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "延迟读取事件",
        },
      },
    } as StreamEvent;

    const view = renderNode();

    expect(taskIdRead).not.toHaveBeenCalled();
    view.updateEvents([event]);
    expect(taskIdRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(taskIdRead).toHaveBeenCalled();
    expect(screen.getByText("延迟读取事件")).toBeInTheDocument();
  });
});
