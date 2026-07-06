// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RequirementTaskNode from "./RequirementTaskNode";
import type {
  RequirementExecutionTask,
  SessionEntry,
  SessionTranscriptPage,
} from "../../types/api";
import { getRequirementTask, getTaskSession } from "../../api/client";

vi.mock("../../api/client", () => ({
  getRequirementTask: vi.fn(),
  getTaskSession: vi.fn(),
}));

function transcript(entries: SessionEntry[] = []): SessionTranscriptPage {
  return { entries, next_before: null, invalid_lines: 0 };
}

function sessionEntry(
  cursor: number,
  role: string,
  blocks: SessionEntry["blocks"],
  source = "代码节点",
): SessionEntry {
  return {
    cursor,
    source,
    line: cursor + 1,
    kind: "message",
    id: `message-${cursor}`,
    role,
    timestamp: `2026-07-01T03:0${cursor}:00.000Z`,
    blocks,
    raw: { type: "message", message: { role } },
  };
}

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
    review_history: [],
    ...overrides,
  };
}

function renderNode({
  nodeTask = task(),
  nodeRole,
  reviews = [],
  dependencies = [],
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
  dependencies?: RequirementExecutionTask[];
  collapsed?: boolean;
  busy?: boolean;
  onRecoverTaskGroup?: (requirementId: string, taskId: string) => Promise<void>;
} = {}) {
  return render(
    <RequirementTaskNode
      data={{
        kind: "requirement-task",
        nodeRole,
        requirementId: "req-1",
        task: nodeTask,
        reviews,
        dependencies,
        busy,
        collapsed,
        onRecoverTaskGroup,
      }}
    />,
  );
}

function resolveTaskDetail(
  nodeTask: RequirementExecutionTask = task(),
  reviews: RequirementExecutionTask[] = [],
) {
  vi.mocked(getRequirementTask).mockResolvedValue({
    task: nodeTask,
    reviews,
    dependencies: [],
  });
}

describe("RequirementTaskNode", () => {
  beforeEach(() => {
    vi.mocked(getRequirementTask).mockImplementation(
      () => new Promise(() => {}),
    );
    vi.mocked(getTaskSession).mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("renders a fixed code node without embedded review cards or detail", () => {
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
    expect(screen.queryByRole("button", { name: "详情" })).toBeNull();
  });

  it("opens the implementation detail from the group only", () => {
    const review = task({
      id: "review-task-1",
      title: "审核登录",
      kind: "review_sub_agent",
      status: "completed",
      review_for: "task-1",
      review_angle: "安全",
      last_review_feedback: "通过",
    });
    const { container } = renderNode({
      nodeRole: "group",
      reviews: [review],
    });
    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    const dialog = document.body.querySelector("dialog");
    expect(container.querySelector("dialog")).toBeNull();
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByText("任务描述")).toBeInTheDocument();
    expect(screen.getByText("实现与审核")).toBeInTheDocument();
    expect(screen.getByText("补齐登录流程")).toBeInTheDocument();
    expect(screen.getByText("会话记录")).toBeInTheDocument();

    const details = document.body.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("基础信息"));

    expect(within(details!).getByText("分支")).toBeInTheDocument();
    expect(within(details!).getByText("rn/req/task-1")).toBeInTheDocument();
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
      nodeRole: "group",
      nodeTask: task({
        execution_warning:
          "未产生新提交：前置节点已实现。按 no-op 完成并进入审核。",
      }),
    });

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

    renderNode({ nodeRole: "group", nodeTask: recoveringTask });
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
    expect(screen.getByText("输入 tokens").nextSibling).toHaveTextContent(
      "1,500",
    );
    expect(screen.getByText("输出 tokens").nextSibling).toHaveTextContent(
      "320",
    );
    expect(screen.getByText("缓存读取").nextSibling).toHaveTextContent("1,000");
    expect(screen.getByText("缓存写入").nextSibling).toHaveTextContent("240");
    expect(screen.getByText("缓存命中率").nextSibling).toHaveTextContent(
      "40.0%",
    );
    expect(screen.getByText("上下文 tokens").nextSibling).toHaveTextContent(
      "12,000",
    );
    expect(screen.getByText("上下文窗口").nextSibling).toHaveTextContent(
      "128,000",
    );
    expect(screen.getByText("上下文占比").nextSibling).toHaveTextContent(
      "9.4%",
    );
  });

  it("does not request task details until the detail is open", async () => {
    const detailed = task({ failure_summary: "按需加载的详情" });
    vi.mocked(getRequirementTask).mockResolvedValue({
      task: detailed,
      reviews: [],
      dependencies: [],
    });
    renderNode();

    expect(getRequirementTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    await waitFor(() =>
      expect(getRequirementTask).toHaveBeenCalledWith("req-1", "task-1"),
    );
    expect(await screen.findByText("按需加载的详情")).toBeInTheDocument();
  });

  it("does not create an EventSource when opening the detail", () => {
    class MockEventSource {
      close = vi.fn();
    }
    vi.stubGlobal("EventSource", MockEventSource);
    const EventSourceSpy = vi.spyOn(globalThis, "EventSource");
    renderNode({
      nodeTask: task({ status: "running" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(EventSourceSpy).not.toHaveBeenCalled();
    EventSourceSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("requests task session when the detail opens", async () => {
    resolveTaskDetail();
    vi.mocked(getTaskSession).mockResolvedValue(transcript());
    renderNode();

    expect(getTaskSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    await waitFor(() =>
      expect(getTaskSession).toHaveBeenCalledWith("req-1", "task-1", undefined),
    );
  });

  it("renders ordered session blocks and hides system messages by default", async () => {
    resolveTaskDetail();
    vi.mocked(getTaskSession).mockResolvedValue(
      transcript([
        sessionEntry(0, "system", [{ type: "text", text: "system prompt" }]),
        sessionEntry(1, "user", [{ type: "text", text: "user request" }]),
        sessionEntry(2, "assistant", [
          { type: "text", text: "assistant reply" },
          { type: "thinking", text: "thinking content" },
          {
            type: "tool_call",
            id: "bash-1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ]),
      ]),
    );
    renderNode();

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(await screen.findByText("会话记录")).toBeInTheDocument();
    expect(screen.queryByText("system prompt")).not.toBeInTheDocument();
    expect(screen.getByText("user request")).toBeInTheDocument();
    expect(screen.getByText("assistant reply")).toBeInTheDocument();
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText(/"command": "ls"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "system" }));
    expect(await screen.findByText("system prompt")).toBeInTheDocument();
  });

  it("renders backend-merged implementation and review sources", async () => {
    const summary = task({
      id: "summary-1",
      title: "登录审核汇总",
      kind: "review_summary",
      review_for: "task-1",
    });
    resolveTaskDetail(task(), [summary]);
    vi.mocked(getTaskSession).mockResolvedValue(
      transcript([
        sessionEntry(
          0,
          "assistant",
          [{ type: "text", text: "完成代码" }],
          "代码节点",
        ),
        sessionEntry(
          1,
          "assistant",
          [{ type: "text", text: "完成审核" }],
          "审核汇总 · 登录审核汇总",
        ),
      ]),
    );
    renderNode({ reviews: [summary] });

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(
      await screen.findByText("审核汇总 · 登录审核汇总"),
    ).toBeInTheDocument();
    expect(screen.getByText("完成代码")).toBeInTheDocument();
    expect(screen.getByText("完成审核")).toBeInTheDocument();
    expect(getTaskSession).toHaveBeenCalledTimes(1);
  });

  it("renders tool results and diffs", async () => {
    resolveTaskDetail();
    vi.mocked(getTaskSession).mockResolvedValue(
      transcript([
        sessionEntry(0, "toolResult", [
          {
            type: "tool_result",
            tool_call_id: "edit-1",
            name: "edit",
            output: "Applied",
            diff: "@@ -1 +1 @@\n-old\n+new",
            is_error: false,
          },
        ]),
      ]),
    );
    const { container } = renderNode();

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    fireEvent.click(await screen.findByText("edit"));

    expect(
      container.ownerDocument.querySelector(".is-added"),
    ).toHaveTextContent("+new");
    expect(
      container.ownerDocument.querySelector(".is-removed"),
    ).toHaveTextContent("-old");
    expect(screen.getByText("Applied")).toBeInTheDocument();
  });

  it("shows session error when session loading fails", async () => {
    resolveTaskDetail();
    vi.mocked(getTaskSession).mockRejectedValue(new Error("读取任务会话失败"));
    renderNode();

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(await screen.findByText("读取任务会话失败")).toBeInTheDocument();
  });

  it("places session usage panel below task description", async () => {
    vi.mocked(getTaskSession).mockResolvedValue(transcript());
    const taskWithUsage = task({
      trace: {
        type: "pi_trace",
        version: 1,
        trace: {
          thinking: "",
          output: "",
          tools: [],
          statuses: [],
          usage: {
            sessionReused: false,
            callCount: 1,
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            context: { tokens: 150, window: 200000, percent: 0.1 },
          },
        },
      },
    });
    vi.mocked(getRequirementTask).mockResolvedValue({
      task: taskWithUsage,
      reviews: [],
      dependencies: [],
    });
    renderNode({ nodeTask: taskWithUsage });

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    const description = await screen.findByText("补齐登录流程");
    const usage = await screen.findByRole("heading", { name: "会话统计" });
    expect(description.compareDocumentPosition(usage)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows persisted implementation and review rounds in two lanes", () => {
    renderNode({
      nodeRole: "group",
      nodeTask: task({
        review_history: [
          {
            round: 1,
            implementation_attempt: 1,
            implementation_summary: "首次实现登录流程",
            status: "rejected",
            started_at: "2026-06-30T00:00:00Z",
            completed_at: "2026-06-30T00:10:00Z",
            reviews: [
              {
                task_id: "security-review",
                angle: "安全审核",
                status: "rejected",
                summary: "发现权限缺口",
                failure_reason: "缺少权限校验",
                completed_at: "2026-06-30T00:08:00Z",
              },
            ],
            summary: "退回修复",
            summary_conclusion: "rejected",
            failure_reason: "需补齐权限校验",
          },
          {
            round: 2,
            implementation_attempt: 2,
            implementation_summary: "补齐权限校验",
            status: "approved",
            started_at: "2026-06-30T00:11:00Z",
            completed_at: "2026-06-30T00:20:00Z",
            reviews: [
              {
                task_id: "security-review",
                angle: "安全审核",
                status: "approved",
                summary: "权限校验通过",
                failure_reason: null,
                completed_at: "2026-06-30T00:18:00Z",
              },
            ],
            summary: "审核通过",
            summary_conclusion: "approved",
            failure_reason: null,
          },
        ],
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(screen.getByText("第 1 轮")).toBeInTheDocument();
    expect(screen.getByText("第 2 轮")).toBeInTheDocument();
    expect(screen.getAllByText("实现 Agent")).toHaveLength(2);
    expect(screen.getAllByText("审核 Agent 组")).toHaveLength(2);
    expect(screen.getAllByText("提交审核 →")).toHaveLength(2);
    expect(screen.getByText("← 反馈退回")).toBeInTheDocument();
    expect(screen.getByText("缺少权限校验")).toBeInTheDocument();
    expect(screen.getByText("权限校验通过")).toBeInTheDocument();
  });

  it("shows dependency merge flow for branch merge details", () => {
    renderNode({
      nodeRole: "external",
      nodeTask: task({
        id: "merge",
        kind: "branch_merge",
        title: "合并功能分支",
        result_summary: "已合并",
      }),
      dependencies: [
        task({
          id: "dependency",
          title: "登录功能",
          branch_name: "rn/login",
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(
      screen.getByRole("heading", { name: "分支合并" }),
    ).toBeInTheDocument();
    expect(screen.getByText("登录功能 · rn/login")).toBeInTheDocument();
    expect(screen.getByText("合并结果")).toBeInTheDocument();
  });

  it("shows final review and publish stages", () => {
    renderNode({
      nodeRole: "external",
      nodeTask: task({
        id: "merge-review",
        kind: "merge_review",
        title: "最终审核发布",
        status: "rejected",
        review_status: "rejected",
        result_summary: "最终检查未通过",
      }),
      dependencies: [task({ id: "merge", title: "合并功能分支" })],
    });

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(screen.getByText("审核发布")).toBeInTheDocument();
    expect(screen.getByText("依赖汇入")).toBeInTheDocument();
    expect(screen.getByText("最终审核")).toBeInTheDocument();
    expect(screen.getByText("最终审核").closest("div")).toHaveClass(
      "is-rejected",
    );
    expect(screen.getAllByText("PR").length).toBeGreaterThan(0);
    expect(screen.getByText("合入目标分支")).toBeInTheDocument();
    expect(screen.getByText("清理资源")).toBeInTheDocument();
  });

  it("marks PR as unnecessary after a local repository merge", () => {
    renderNode({
      nodeRole: "external",
      nodeTask: task({
        id: "merge-review",
        kind: "merge_review",
        title: "最终审核发布",
        pull_request_url: null,
        merged_into: "main",
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(screen.getByText("本地仓库，无需 PR")).toBeInTheDocument();
    expect(
      screen
        .getByText("本地仓库，无需 PR")
        .closest(".task-detail-dialog__stage"),
    ).toHaveClass("is-approved");
  });
});
