import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RequirementsWorkbench from "./RequirementsWorkbench";

const reactFlowProps = vi.hoisted(() => vi.fn());

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowProps(props);
    return (
      <section data-testid="requirements-flow">
        {props.children as React.ReactNode}
      </section>
    );
  },
}));

vi.mock("../nodes/StartNode", () => ({ default: () => null }));

describe("RequirementsWorkbench", () => {
  it("keeps the nested DAG camera interactive", () => {
    render(<RequirementsWorkbench nodes={[]} edges={[]} />);
    expect(reactFlowProps).toHaveBeenCalledWith(
      expect.objectContaining({
        className: "requirements-inner-flow",
        panOnScroll: true,
        minZoom: 0.2,
        maxZoom: 1.4,
      }),
    );
  });
});
