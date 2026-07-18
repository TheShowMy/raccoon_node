import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, type RenderResult } from "@testing-library/react";
import { axe } from "jest-axe";
import { createRef, type ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildDemoPlan, demoSpec } from "../api/mock/demoContent";
import type { Notification, Requirement, Run } from "../api/types";
import { createGraphState } from "../chat/dag";
import { GrayDangoHost } from "../components/pet/GrayDangoHost";
import {
  initialCanvasNavigationState,
  useCanvasStore,
} from "../store/canvasStore";
import { useDeliveryStore } from "../store/deliveryStore";
import { useDomainStore } from "../store/domainStore";
import { DeliveryWorkbench } from "../workbenches/delivery/DeliveryWorkbench";

/**
 * axe 组件级可访问性扫描（02 §10、§12.1）。
 * critical/serious 违例必须为零；minor/moderate 记录到控制台。
 * jsdom 无真实排版与样式计算，color-contrast 在 jsdom 下不可判定，予以关闭，
 * 由浏览器阶段（Playwright/手工）复核。
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
  // 相机时长归零（reduced-motion），键盘冒烟不必等 420ms 动画
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

const AXE_OPTIONS = {
  rules: { "color-contrast": { enabled: false } },
};

type AxeResults = Awaited<ReturnType<typeof axe>>;

/** critical/serious 断言为零；其余记录（P4 报告摘录） */
async function expectNoSeriousViolations(container: Element, label: string) {
  const results: AxeResults = await axe(container, AXE_OPTIONS);
  const serious = results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );
  const minor = results.violations.filter(
    (violation) =>
      violation.impact !== "critical" && violation.impact !== "serious",
  );
  if (minor.length > 0) {
    console.info(
      `[axe:${label}] 轻微问题 ${minor.length} 条：`,
      minor.map((violation) => `${violation.id}(${violation.impact})`),
    );
  }
  expect(
    serious.map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`,
    ),
    `${label} 存在 critical/serious 可访问性违例`,
  ).toEqual([]);
}

function notification(
  partial: Partial<Notification> & Pick<Notification, "id">,
): Notification {
  return {
    severity: "warning",
    message: `通知 ${partial.id}`,
    source_workbench: "system",
    source_node_id: null,
    lifecycle: "active",
    raised_at: "2026-01-01T00:00:00.000Z",
    acknowledged_at: null,
    resolved_at: null,
    ...partial,
  };
}

beforeEach(() => {
  useDomainStore.setState({
    conversation: createGraphState("g-main", "b-main"),
    notifications: {},
  });
  useCanvasStore.setState({ ...initialCanvasNavigationState });
});

function renderWithProviders(ui: ReactElement, route = "/"): RenderResult {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("axe 组件级扫描（02 §10）", () => {
  it("GrayDango 通知队列（含阻断与警告）", async () => {
    useDomainStore.setState({
      notifications: {
        "ntf-err": notification({
          id: "ntf-err",
          severity: "error",
          message: "终端会话意外断开。",
        }),
        "ntf-warn": notification({
          id: "ntf-warn",
          severity: "warning",
          message: "任务已知费用接近冻结预算。",
        }),
      },
    });
    const containerRef = createRef<HTMLElement>();
    const { container } = renderWithProviders(
      <section ref={containerRef}>
        <GrayDangoHost containerRef={containerRef} />
      </section>,
    );
    // 队列气泡与播报
    const pet = screen.getByLabelText("GrayDango 项目助手");
    const queue = screen.getByLabelText("通知队列");
    expect(queue).toBeInTheDocument();
    expect(pet).toContainElement(queue);
    expect(screen.getByRole("button", { name: "确认" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "前一条通知" }),
    ).toBeInTheDocument();
    await expectNoSeriousViolations(container, "GrayDango 通知队列");
  });

  it("需求交付工作台首屏", async () => {
    const requirement: Requirement = {
      id: "req-a11y",
      title: "可访问性需求",
      state: "queued",
      source_session_id: "s-main",
      source_branch_id: "b-main",
      source_node_ids: [],
      latest_revision: 1,
      confirmed_revision: 1,
      queue_position: 1,
      latest_run_id: "run-a11y",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const run: Run = {
      id: "run-a11y",
      requirement_id: "req-a11y",
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
    useDomainStore.setState({
      requirements: { "req-a11y": requirement },
      clarifications: {},
      revisions: {
        "req-a11y": [
          {
            requirement_id: "req-a11y",
            revision: 1,
            spec: demoSpec("可访问性需求", "两者都涉及"),
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
      runs: { "run-a11y": run },
      plans: { "run-a11y": buildDemoPlan("plan-a11y", "run-a11y", 1) },
      validations: {},
      reviews: {},
      publications: {},
      actions: {},
    });
    useDeliveryStore.setState({
      selectedRequirementId: "req-a11y",
      focusRequest: null,
    });
    const { container } = renderWithProviders(
      <DeliveryWorkbench />,
      "/canvas/workbenches/delivery",
    );
    expect(await screen.findByText("需求列表")).toBeInTheDocument();
    expect(screen.getByText("可访问性需求")).toBeInTheDocument();
    await expectNoSeriousViolations(container, "需求交付工作台");
  });
});
