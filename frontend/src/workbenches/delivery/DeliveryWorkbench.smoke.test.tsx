import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it } from "vitest";
import { buildDemoPlan, demoSpec } from "../../api/mock/demoContent";
import type { Requirement, Run } from "../../api/types";
import { useDomainStore } from "../../store/domainStore";
import { useDeliveryStore } from "../../store/deliveryStore";
import { DeliveryWorkbench } from "./DeliveryWorkbench";

/**
 * 需求交付工作台渲染冒烟：嵌套 React Flow 在 jsdom 挂载、
 * 列表锚点与确定需求执行流水线渲染、选中需求驱动展开。
 */
beforeAll(() => {
  // jsdom 缺少 ResizeObserver：XYFlow 挂载需要
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    value: ResizeObserverMock,
  });
});

const requirement: Requirement = {
  id: "req-smoke",
  title: "冒烟需求",
  state: "queued",
  source_session_id: "s-main",
  source_branch_id: "b-main",
  source_node_ids: [],
  latest_revision: 1,
  confirmed_revision: 1,
  queue_position: 1,
  latest_run_id: "run-smoke",
  created_at: "2026-01-01T00:00:00.000Z",
};

const run: Run = {
  id: "run-smoke",
  requirement_id: "req-smoke",
  requirement_revision: 1,
  phase: "reviewing",
  resume_phase: null,
  outcome: null,
  blocked_reason: null,
  cancel_reason: null,
  current_activity: "三角度独立审核中。",
  publication_path: "github_pull_request",
  publication_frozen_reason: "远端 ready，冻结为 PR。",
  task_budget_usd: 25,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function seed() {
  useDomainStore.setState({
    requirements: { "req-smoke": requirement },
    clarifications: {},
    revisions: {
      "req-smoke": [
        {
          requirement_id: "req-smoke",
          revision: 1,
          spec: demoSpec("冒烟需求", "两者都涉及"),
          semantic_hash: "deadbeef",
          created_at: "2026-01-01T00:00:00.000Z",
          source_graph_id: "g-main",
          source_branch_id: "b-main",
          source_node_ids: [],
          confirmation: {
            revision: 1,
            confirmed_at: "2026-01-01T00:00:00.000Z",
            task_budget_usd: 25,
          },
        },
      ],
    },
    runs: { "run-smoke": run },
    plans: { "run-smoke": buildDemoPlan("plan-smoke", "run-smoke", 1) },
    validations: {},
    reviews: {},
    publications: {},
    actions: {},
  });
  useDeliveryStore.setState({
    selectedRequirementId: "req-smoke",
    focusRequest: null,
    diagnosticsRunId: null,
  });
}

function renderWorkbench() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/canvas/workbenches/delivery"]}>
        <DeliveryWorkbench />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DeliveryWorkbench 冒烟", () => {
  it("渲染列表锚点与选中确定需求的执行流水线", async () => {
    seed();
    const { container } = renderWorkbench();
    expect(container.querySelector(".react-flow")).toBeInTheDocument();
    expect(screen.getByText("需求列表")).toBeInTheDocument();
    expect(screen.getByText("冒烟需求")).toBeInTheDocument();
    expect(screen.getByText("确定需求")).toBeInTheDocument();
    expect(screen.queryByText("规格")).not.toBeInTheDocument();
    expect(screen.queryByText("确认")).not.toBeInTheDocument();
    expect(screen.getByText("Run")).toBeInTheDocument();
    expect(screen.getByText("WorkPlan")).toBeInTheDocument();
    expect(screen.getByText("合并任务")).toBeInTheDocument();
    expect(screen.getByText("Integration Diff")).toBeInTheDocument();
    expect(screen.getByText("验证")).toBeInTheDocument();
    expect(screen.getByText("审核")).toBeInTheDocument();
    expect(screen.getByText("发布")).toBeInTheDocument();
    expect(screen.queryByLabelText("诊断节点")).not.toBeInTheDocument();
    // 默认验收界面不得挂载演示控制台；只允许显式开发环境变量开启。
    expect(screen.queryByText("演示控制台")).not.toBeInTheDocument();
  });
});
