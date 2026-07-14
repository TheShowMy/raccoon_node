import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RequirementsWorkbench from "./RequirementsWorkbench";

const reactFlowProps = vi.hoisted(() => vi.fn());
const fitView = vi.hoisted(() => vi.fn());
const getNodes = vi.hoisted(() => vi.fn(() => []));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  useReactFlow: () => ({ fitView, getNodes }),
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowProps(props);
    return (
      <section data-testid="requirements-flow">
        {props.children as React.ReactNode}
      </section>
    );
  },
}));

vi.mock("../nodes/RequirementNode", () => ({ default: () => null }));

describe("RequirementsWorkbench", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("keeps the nested Workflow camera interactive", () => {
    render(<RequirementsWorkbench nodes={[]} edges={[]} />);
    expect(reactFlowProps).toHaveBeenCalledWith(
      expect.objectContaining({
        className: "requirements-inner-flow",
        panOnScroll: true,
        noWheelClassName: "nowheel",
        minZoom: 0.2,
        maxZoom: 1.4,
        nodesDraggable: false,
        zIndexMode: "auto",
      }),
    );
  });

  it("fits once per structural layout signature", () => {
    const view = render(<RequirementsWorkbench nodes={[]} edges={[]} />);
    expect(fitView).toHaveBeenCalledTimes(1);

    view.rerender(<RequirementsWorkbench nodes={[]} edges={[]} />);
    expect(fitView).toHaveBeenCalledTimes(1);

    view.rerender(
      <RequirementsWorkbench
        nodes={[
          {
            id: "requirements",
            type: "startNode",
            position: { x: 0, y: 0 },
            style: { width: 320, height: 640 },
            data: {} as never,
          },
        ]}
        edges={[]}
      />,
    );
    expect(fitView).toHaveBeenCalledTimes(2);
    expect(fitView).toHaveBeenLastCalledWith({
      nodes: [],
      padding: 0.08,
      duration: 220,
    });
  });
});
