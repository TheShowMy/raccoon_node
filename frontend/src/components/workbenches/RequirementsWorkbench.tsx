import {
  Background,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import StartNode from "../nodes/StartNode";
import type { StartNodeData } from "../../types/api";

export default function RequirementsWorkbench({
  nodes,
  edges,
}: {
  nodes: Node<StartNodeData>[];
  edges: Edge[];
}) {
  return (
    <ReactFlowProvider>
      <ReactFlow
        className="requirements-inner-flow"
        nodes={nodes}
        edges={edges}
        nodeTypes={{ startNode: StartNode }}
        fitView
        fitViewOptions={{ padding: 0.08, duration: 220 }}
        minZoom={0.2}
        maxZoom={1.4}
        nodesConnectable={false}
        panOnScroll
        defaultEdgeOptions={{
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        }}
      >
        <Background color="var(--color-border-subtle)" gap={28} size={1} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
