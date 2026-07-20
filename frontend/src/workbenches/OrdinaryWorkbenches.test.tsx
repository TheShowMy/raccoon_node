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
import { useGitStore } from "../store/gitStore";
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
  useGitStore.setState({
    compactPane: "repository",
    selectedChangePath: null,
    selectedChangePaths: [],
    commitMessage: "",
    newBranchName: "",
  });
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

  it("Git 支持独立文件选择、跨组批量操作和分组三态全选", () => {
    renderWorkbench(<GitWorkbench />);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "选择 frontend/src/canvas/nodes.tsx",
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "选择 docs/rewrite/TODO.md" }),
    );
    const bulk = screen.getByLabelText("Git 批量操作");
    expect(bulk).toHaveTextContent("已选 2");
    expect(screen.getByRole("button", { name: "暂存所选（2）" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "取消暂存（0）" }),
    ).toBeDisabled();

    const stagedGroup = screen.getByRole("checkbox", { name: "全选已暂存" });
    fireEvent.click(stagedGroup);
    expect(stagedGroup).toBeChecked();
    expect(screen.getByLabelText("Git 批量操作")).toHaveTextContent("已选 7");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "选择 frontend/src/theme/tokens.css",
      }),
    );
    expect(stagedGroup).toHaveProperty("indeterminate", true);
  });

  it("用量点阵只有一个 Tab 停靠点并用方向键按周移动", () => {
    renderWorkbench(<UsageWorkbench />);
    const heatmap = screen.getByLabelText("最近 365 天每日 Token 点阵图");
    const days = Array.from(heatmap.querySelectorAll("button"));
    expect(days).toHaveLength(365);
    expect(days.filter((day) => day.tabIndex === 0)).toHaveLength(1);
    expect(days[364]).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(days[364], { key: "ArrowLeft" });
    expect(days[357]).toHaveAttribute("tabindex", "0");
    expect(days[364]).toHaveAttribute("tabindex", "-1");
  });
});
