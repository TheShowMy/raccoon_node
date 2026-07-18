import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { getApi } from "../api";
import { useDomainStore } from "../store/domainStore";
import { useSettingsWorkbenchStore } from "../store/settingsWorkbenchStore";
import { FilesWorkbench } from "./files/FilesWorkbench";
import { GitWorkbench } from "./git/GitWorkbench";
import { SettingsWorkbench } from "./settings/SettingsWorkbench";
import { TerminalWorkbench } from "./terminal/TerminalWorkbench";
import { UsageWorkbench } from "./usage/UsageWorkbench";

function renderWorkbench(ui: ReactElement): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(async () => {
  const snapshot = await getApi().getSnapshot();
  useDomainStore.getState().initFromSnapshot(snapshot);
  useSettingsWorkbenchStore.setState({ activeCategory: "general" });
});

describe("普通工作台使用连续工具页而不是嵌套 React Flow", () => {
  const cases: Array<[string, ReactElement, number]> = [
    ["文件", <FilesWorkbench />, 2],
    ["Git", <GitWorkbench />, 3],
    ["用量统计", <UsageWorkbench />, 0],
    ["设置", <SettingsWorkbench />, 2],
  ];

  for (const [label, workbench, paneCount] of cases) {
    it(`${label}工作台只渲染主要 pane`, () => {
      const { container } = renderWorkbench(workbench);
      expect(container.querySelector(".react-flow")).toBeNull();
      expect(container.querySelectorAll("[data-pane-id]")).toHaveLength(
        paneCount,
      );
      expect(container.querySelector(".workbench-grid")).toBeNull();
      expect(container.querySelector(".workbench-panel")).toBeNull();
      expect(container.querySelector(".react-flow__handle")).toBeNull();
    });
  }

  it("终端工作台在没有会话时仍只有一个活动会话 pane", () => {
    useDomainStore.setState({ terminals: {} });
    const { container } = renderWorkbench(<TerminalWorkbench />);
    expect(container.querySelector(".react-flow")).toBeNull();
    expect(
      container.querySelector("[data-pane-id='terminal-active-session']"),
    ).toBeInTheDocument();
    expect(container.querySelector(".workbench-panel")).toBeNull();
  });

  it("设置只有四个大类，模型配置完整并入设置", () => {
    renderWorkbench(<SettingsWorkbench />);
    const categories = screen.getByRole("navigation", { name: "设置分类" });
    expect(categories.querySelectorAll("button")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(screen.getByLabelText("模型配置")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Provider 列表")).toHaveLength(2);
    expect(screen.getByLabelText("五角色配置")).toBeInTheDocument();
  });

  it("用量页只有 Token 统计，不出现模型凭据、角色编辑或预算进度", () => {
    renderWorkbench(<UsageWorkbench />);
    expect(screen.getByLabelText("Token 指标")).toBeInTheDocument();
    expect(
      screen.getByLabelText("最近 365 天每日 Token 点阵图"),
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveAccessibleName("模型消耗");
    expect(screen.queryByText("凭据")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("五角色配置")).not.toBeInTheDocument();
    expect(screen.queryByText(/预算进度|软阈值/)).not.toBeInTheDocument();
  });
});
