import {
  applyNodeChanges,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useState } from "react";
import type { WorkbenchKind } from "../../api/types";
import { useCanvasStore, type Viewport } from "../../store/canvasStore";

export type SubFlowNode = Node<Record<string, unknown>>;

export type SubProjection = {
  nodes: SubFlowNode[];
  edges: Edge[];
};

/**
 * 工作台嵌套子画布（DeliveryWorkbench 范式）：受控 viewport 按工作台持久化，
 * onNodeClick 空操作——XYFlow 无 flow 级 onNodeClick 时节点包装层不启用
 * pointer-events，子画布全部点击会穿透（与 MainCanvas 同一规则）。
 */
const SubCanvasInner = memo(function SubCanvasInner({
  kind,
  nodeTypes,
  projection,
  ariaLabel,
  defaultViewport = { x: 24, y: 24, zoom: 0.85 },
}: {
  kind: WorkbenchKind;
  nodeTypes: NodeTypes;
  projection: SubProjection;
  ariaLabel: string;
  defaultViewport?: Viewport;
}) {
  const [nodes, setNodes] = useState<SubFlowNode[]>(projection.nodes);
  useEffect(() => {
    setNodes(projection.nodes);
  }, [projection]);
  const onNodesChange = useCallback(
    (changes: NodeChange<SubFlowNode>[]) =>
      setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const viewport = useCanvasStore(
    (state) => state.workbenchViewports[kind] ?? defaultViewport,
  );

  return (
    <div className="sub-canvas nodrag nowheel">
      <ReactFlow
        nodes={nodes}
        edges={projection.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        viewport={viewport}
        onViewportChange={(next) =>
          useCanvasStore.getState().saveWorkbenchViewport(kind, next)
        }
        onNodeClick={() => {
          // 见上方注释：保留空操作以启用节点 pointer-events
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.3}
        maxZoom={1.4}
        proOptions={{ hideAttribution: true }}
        aria-label={ariaLabel}
      />
    </div>
  );
});

export function SubCanvas(props: Parameters<typeof SubCanvasInner>[0]) {
  return (
    <ReactFlowProvider>
      <SubCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
