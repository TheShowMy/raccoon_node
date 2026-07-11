import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePanelEscape } from "./usePanelEscape";

describe("usePanelEscape", () => {
  it("closes an open workspace panel with Escape", () => {
    const onClose = vi.fn();
    renderHook(() => usePanelEscape("settings", onClose));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close without a panel or after an inner handler prevents Escape", () => {
    const onClose = vi.fn();
    const hook = renderHook(({ panel }) => usePanelEscape(panel, onClose), {
      initialProps: { panel: "settings" as "settings" | null },
    });
    const prevented = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(onClose).not.toHaveBeenCalled();

    hook.rerender({ panel: null });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
