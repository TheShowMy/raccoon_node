import React, { useState, useRef, useEffect } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { StartNodeData } from "../../types/api";
import { renderNodeContent } from "../../nodes/renderNodeContent";

function StartNode({ data }: NodeProps<Node<StartNodeData>>) {
  const hasRequirementChatLeftHandle = data.kind === "requirement-chat";
  const hasRequirementChatRightHandle = data.kind === "requirement-chat";
  const hasRequirementListLeftHandle =
    data.kind === "requirement-list" && data.tone === "pending";
  const hasRequirementListRightHandle = data.kind === "requirement-list";
  const hasRequirementDagLeftHandle = data.kind === "requirement-dag";
  const hasRequirementDagRightHandle = false;
  const hasRequirementTaskLeftHandle = data.kind === "requirement-task";
  const hasRequirementTaskRightHandle = data.kind === "requirement-task";

  return (
    <div
      className={`node-card node-card--${data.kind} ${
        data.kind === "project-github" ? "compact" : ""
      }`}
    >
      {hasRequirementChatLeftHandle ? (
        <Handle
          id="requirement-chat-left"
          type="target"
          position={Position.Left}
          className="node-link-handle node-link-handle--requirement"
        />
      ) : null}
      {hasRequirementListLeftHandle ? (
        <Handle
          id="requirement-list-left"
          type="target"
          position={Position.Left}
          className="node-link-handle node-link-handle--requirement"
        />
      ) : null}
      {hasRequirementDagLeftHandle ? (
        <Handle
          id="requirement-dag-left"
          type="target"
          position={Position.Left}
          className="node-link-handle node-link-handle--requirement"
        />
      ) : null}
      {hasRequirementTaskLeftHandle ? (
        <Handle
          id="requirement-task-left"
          type="target"
          position={Position.Left}
          className="node-link-handle node-link-handle--requirement"
        />
      ) : null}
      {renderNodeContent(data)}
      {hasRequirementChatRightHandle ? (
        <Handle
          id="requirement-chat-right"
          type="source"
          position={Position.Right}
          className="node-link-handle node-link-handle--requirement"
        />
      ) : null}
      {hasRequirementListRightHandle ? (
        <Handle
          id="requirement-list-right"
          type="source"
          position={Position.Right}
          className="node-link-handle node-link-handle--requirement"
        />
      ) : null}
      {hasRequirementDagRightHandle ? (
        <Handle
          id="requirement-dag-right"
          type="source"
          position={Position.Right}
          className="node-link-handle node-link-handle--requirement"
        />
      ) : null}
      {hasRequirementTaskRightHandle ? (
        <Handle
          id="requirement-task-right"
          type="source"
          position={Position.Right}
          className="node-link-handle node-link-handle--requirement"
        />
      ) : null}
    </div>
  );
}

export default React.memo(StartNode);
