import {
  Background,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import { useEffect, useMemo } from "react";
import RequirementNode from "../nodes/RequirementNode";
import type { RequirementNodeData } from "../../types/api";

export default function RequirementsWorkbench({
  nodes,
  edges,
}: {
  nodes: Node<RequirementNodeData>[];
  edges: Edge[];
}) {
  const layoutSignature = useMemo(
    () =>
      nodes
        .map((node) =>
          [
            node.id,
            node.parentId ?? "",
            node.position.x,
            node.position.y,
            node.width ?? node.style?.width ?? "",
            node.height ?? node.style?.height ?? "",
            node.hidden ? 1 : 0,
          ].join(":"),
        )
        .join("|"),
    [nodes],
  );

  return (
    <ReactFlowProvider>
      <ReactFlow
        className="requirements-inner-flow"
        nodes={nodes}
        edges={edges}
        nodeTypes={{ startNode: RequirementNode }}
        minZoom={0.2}
        maxZoom={1.4}
        nodesConnectable={false}
        nodesDraggable={false}
        panOnScroll
        noWheelClassName="nowheel"
        zIndexMode="auto"
        defaultEdgeOptions={{
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        }}
      >
        <RequirementViewportSync layoutSignature={layoutSignature} />
        <Background color="var(--color-border)" gap={28} size={1} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

function RequirementViewportSync({
  layoutSignature,
}: {
  layoutSignature: string;
}) {
  const { fitView, getNodes } = useReactFlow();

  useEffect(() => {
    let frame = 0;
    let attempts = 0;
    let previousGeometry: string | null = null;
    const fitWhenStable = () => {
      const currentNodes = getNodes();
      const geometry = currentNodes
        .map((node) =>
          [
            node.id,
            node.position.x,
            node.position.y,
            node.measured?.width ?? node.width ?? "",
            node.measured?.height ?? node.height ?? "",
          ].join(":"),
        )
        .join("|");

      if (geometry === previousGeometry || attempts >= 3) {
        void fitView({ nodes: currentNodes, padding: 0.08, duration: 220 });
        return;
      }
      previousGeometry = geometry;
      attempts += 1;
      frame = requestAnimationFrame(fitWhenStable);
    };
    frame = requestAnimationFrame(fitWhenStable);
    return () => cancelAnimationFrame(frame);
  }, [fitView, getNodes, layoutSignature]);

  return null;
}
