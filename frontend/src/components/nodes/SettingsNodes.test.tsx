import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StartNodeData } from "../../types/api";
import BasicSettingsNode from "./BasicSettingsNode";
import SettingsListNode from "./SettingsListNode";

it("routes both setting cards and closes the list", () => {
  const onOpenBasic = vi.fn();
  const onOpenModels = vi.fn();
  const onClose = vi.fn();

  render(
    <SettingsListNode
      data={{
        kind: "settings-list",
        onOpenBasic,
        onOpenModels,
        onClose,
      }}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /基础设置/ }));
  fireEvent.click(screen.getByRole("button", { name: /模型设置/ }));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(onOpenBasic).toHaveBeenCalledOnce();
  expect(onOpenModels).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

it("validates the native port input before saving", () => {
  let data = {
    kind: "basic-settings",
    settings: { theme: "dark", port: 3000, port_overridden: false },
    error: null,
    saving: false,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onSave: vi.fn(async () => {}),
  } satisfies Extract<StartNodeData, { kind: "basic-settings" }>;
  const { rerender } = render(<BasicSettingsNode data={data} />);

  fireEvent.change(screen.getByRole("spinbutton"), {
    target: { value: "65536" },
  });
  expect(data.onChange).toHaveBeenCalledWith({
    ...data.settings,
    port: 65536,
  });

  data = {
    ...data,
    settings: { ...data.settings, port: 65536 },
  };
  rerender(<BasicSettingsNode data={data} />);
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
});
