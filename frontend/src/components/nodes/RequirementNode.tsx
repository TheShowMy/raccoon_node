import React from "react";
import { Card } from "@astryxdesign/core/Card";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { RequirementNodeData } from "../../types/api";
import RequirementListNode from "./RequirementListNode";
import WorkflowItemNode from "./WorkflowItemNode";
import WorkflowRunNode from "./WorkflowRunNode";

const HANDLES: Record<
  RequirementNodeData["kind"],
  Array<{ id: string; position: Position; type: "source" | "target" }>
> = {
  "requirement-list": [
    { id: "requirement-list-left", position: Position.Left, type: "target" },
    { id: "requirement-list-right", position: Position.Right, type: "source" },
  ],
  "workflow-run": [
    { id: "workflow-run-left", position: Position.Left, type: "target" },
  ],
  "workflow-item": [
    { id: "workflow-item-left", position: Position.Left, type: "target" },
    { id: "workflow-item-right", position: Position.Right, type: "source" },
  ],
};

function content(data: RequirementNodeData) {
  switch (data.kind) {
    case "requirement-list":
      return <RequirementListNode data={data} />;
    case "workflow-run":
      return <WorkflowRunNode data={data} />;
    case "workflow-item":
      return <WorkflowItemNode data={data} />;
  }
}

function RequirementNode({ data }: NodeProps<Node<RequirementNodeData>>) {
  return (
    <Card
      width="100%"
      height="100%"
      padding={0}
      className={`node-card node-card--${data.kind}`}
    >
      {HANDLES[data.kind].map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type={handle.type}
          position={handle.position}
          className="node-link-handle node-link-handle--requirement"
        />
      ))}
      {content(data)}
    </Card>
  );
}

export default React.memo(RequirementNode);
