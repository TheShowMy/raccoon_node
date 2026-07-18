import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const { container } = render(
      <div className="tool-workbench">
        <WorkbenchActionDock
          actions={[
            action("second", "2026-01-02T00:00:00Z"),
            action("first", "2026-01-01T00:00:00Z"),
          ]}
        />
      </div>,
    );
    expect(screen.getByLabelText(/危险操作确认:丢弃 first/)).toBeVisible();
    expect(screen.getByText("另有 1 项待确认")).toBeVisible();
    const dock = container.querySelector(".workbench-action-dock");
    expect(dock).toBe(
      container.querySelector(".tool-workbench")?.lastElementChild,
    );
    expect(container.querySelector(".inline-action-strip")).toBeNull();
  });

  it("完成结果展示 3 秒后收起，领域 action 本身仍由 store 保留", () => {
    vi.useFakeTimers();
    const pending = action("one", "2026-01-01T00:00:00Z");
    const { rerender } = render(<WorkbenchActionDock actions={[pending]} />);
    rerender(
      <WorkbenchActionDock
        actions={[
          {
            ...pending,
            state: "confirmed",
            result: { ok: true, message: "已完成" },
            updated_at: "2026-01-01T00:00:01Z",
          },
        ]}
      />,
    );
    expect(screen.getByLabelText(/操作结果:丢弃 one/)).toBeVisible();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByLabelText(/操作结果:丢弃 one/)).toBeNull();
  });
});
