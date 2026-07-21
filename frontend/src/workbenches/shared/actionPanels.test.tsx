import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getApi } from "../../api";
import type { WorkbenchAction } from "../../api/types";
import { WorkbenchActionDock } from "./actionPanels";

const action = (id: string, createdAt: string): WorkbenchAction => ({
  id,
  kind: "git_discard",
  title: `丢弃 ${id}`,
  impact: "工作区修改将被删除。",
  irreversible: true,
  source_node_id: null,
  payload: { path: `${id}.ts` },
  confirm_token: `token-${id}`,
  state: "awaiting",
  result: null,
  created_at: createdAt,
  updated_at: createdAt,
});

afterEach(() => vi.useRealTimers());

describe("WorkbenchActionDock", () => {
  it("按创建时间显示一个前台确认并保留待确认队列数量", () => {
    const client = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <div className="tool-workbench">
          <WorkbenchActionDock
            actions={[
              action("second", "2026-01-02T00:00:00Z"),
              action("first", "2026-01-01T00:00:00Z"),
            ]}
          />
        </div>
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText(/危险操作确认:丢弃 first/)).toBeVisible();
    expect(screen.getByText("另有 1 项待确认")).toBeVisible();
    const dock = container.querySelector(".workbench-action-dock");
    expect(dock).toBe(
      container.querySelector(".tool-workbench")?.lastElementChild,
    );
  });

  it("完成结果展示 3 秒后收起，领域 action 本身仍由 store 保留", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const pending = action("one", "2026-01-01T00:00:00Z");
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <WorkbenchActionDock actions={[pending]} />
      </QueryClientProvider>,
    );
    rerender(
      <QueryClientProvider client={client}>
        <WorkbenchActionDock
          actions={[
            {
              ...pending,
              state: "confirmed",
              result: { ok: true, message: "已完成" },
              updated_at: "2026-01-01T00:00:01Z",
            },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText(/操作结果:丢弃 one/)).toBeVisible();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByLabelText(/操作结果:丢弃 one/)).toBeNull();
  });

  it("确认 mutation 透传当前 action id 与确认 token", async () => {
    const client = new QueryClient();
    const pending = action("token-check", "2026-01-01T00:00:00Z");
    let resolveConfirm: (() => void) | undefined;
    const confirm = vi
      .spyOn(getApi(), "confirmWorkbenchAction")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveConfirm = resolve;
          }),
      );
    render(
      <QueryClientProvider client={client}>
        <WorkbenchActionDock actions={[pending]} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(confirm).toHaveBeenCalledWith({
      action_id: pending.id,
      confirm_token: pending.confirm_token,
    });
    resolveConfirm?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled(),
    );
  });
});
