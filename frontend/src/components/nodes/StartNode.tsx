import React from "react";
import { Card } from "@astryxdesign/core/Card";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { StartNodeData } from "../../types/api";
import { renderNodeContent } from "../../nodes/renderNodeContent";

type StartNodeKind = StartNodeData["kind"];

const HANDLES_BY_KIND: Record<
  StartNodeKind,
  Array<{ id: string; position: Position; type: "source" | "target" }>
> = {
  "requirement-chat": [
    { id: "requirement-chat-left", position: Position.Left, type: "target" },
    { id: "requirement-chat-right", position: Position.Right, type: "source" },
  ],
  "requirement-list": [
    { id: "requirement-list-left", position: Position.Left, type: "target" },
    { id: "requirement-list-right", position: Position.Right, type: "source" },
  ],
  "requirement-dag": [
    { id: "requirement-dag-left", position: Position.Left, type: "target" },
  ],
  "requirement-task": [
    { id: "requirement-task-left", position: Position.Left, type: "target" },
    { id: "requirement-task-right", position: Position.Right, type: "source" },
  ],
  "project-settings": [],
  "project-terminal": [],
  "project-git": [],
  "token-usage": [],
};

function StartNode({ data }: NodeProps<Node<StartNodeData>>) {
  const handles = HANDLES_BY_KIND[data.kind];

  return (
    <Card
      width="100%"
      height="100%"
      padding={0}
      className={`node-card node-card--${data.kind}`}
    >
      {handles.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type={handle.type}
          position={handle.position}
          className="node-link-handle node-link-handle--requirement"
        />
      ))}
      {renderNodeContent(data)}
    </Card>
  );
}

export default React.memo(StartNode);
