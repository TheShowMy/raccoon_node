import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * P0 集成冒烟：验证 @pxlkit/ui-kit 与 Vite 8 + React 19 的兼容性。
 * 若此处失败，按 ADR-002 风险回退为 RetroUI + 自研基础件。
 */
describe("@pxlkit/ui-kit integration", () => {
  it("imports the kit and renders a primitive", async () => {
    const kit = await import("@pxlkit/ui-kit");
    const names = Object.keys(kit);
    expect(names.length).toBeGreaterThan(0);

    const Candidate =
      (kit as Record<string, unknown>).PixelButton ??
      (kit as Record<string, unknown>).PxlKitButton ??
      (kit as Record<string, unknown>).Button;
    expect(typeof Candidate).toMatch(/function|object/);

    const ButtonComponent = Candidate as React.ComponentType<{
      children?: React.ReactNode;
    }>;
    render(<ButtonComponent>确定</ButtonComponent>);
    expect(screen.getByText("确定")).toBeInTheDocument();
  });

  it("imports @pxlkit/core utilities", async () => {
    const core = await import("@pxlkit/core");
    expect(Object.keys(core).length).toBeGreaterThan(0);
  });
});
