import React, { useState, useRef, useEffect } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { StartNodeData } from "../../types/api";
import CreateProjectNode from "./CreateProjectNode";
import ProjectListNode from "./ProjectListNode";
import ProjectItemNode from "./ProjectItemNode";
import DeleteConfirmNode from "./DeleteConfirmNode";
import ModelConfigNode from "./ModelConfigNode";
import StyleSettingsNode from "./StyleSettingsNode";
import SummaryCard from "./SummaryCard";
import ProjectBackNode from "./ProjectBackNode";
import RequirementListNode from "./RequirementListNode";
import RequirementChatNode from "./RequirementChatNode";

const nodeTypeMap: Record<string, React.FC<any>> = {
  create: CreateProjectNode,
  projects: ProjectListNode,
  "project-item": ProjectItemNode,
  "delete-confirm": DeleteConfirmNode,
  "model-config": ModelConfigNode,
  "style-settings": StyleSettingsNode,
  summary: SummaryCard,
  "project-back": ProjectBackNode,
  "requirement-list": RequirementListNode,
  "requirement-chat": RequirementChatNode,
};

export default function StartNode({ data }: NodeProps<Node<StartNodeData>>) {
  const isPendingDelete =
    data.kind === "project-item" &&
    data.pendingDeleteProjectId === data.project.id;
  const clickableAction =
    data.kind === "summary"
      ? data.onAction
      : data.kind === "project-back"
        ? data.onBack
        : undefined;
  const hasFlowLeftHandle = data.kind === "create" || data.kind === "projects";
  const hasModelSourceHandle = data.kind === "summary" && data.icon === "model";
  const hasModelTargetHandle = data.kind === "model-config";
  const hasDeleteRightHandle = data.kind === "project-item";
  const hasDeleteLeftHandle = data.kind === "delete-confirm";

  const ContentComponent = nodeTypeMap[data.kind];

  return (
    <div
      className={`node-card node-card--${data.kind} ${
        isPendingDelete ? "node-card--pending-delete" : ""
      } ${clickableAction ? "node-card--clickable" : ""}`}
      role={clickableAction ? "button" : undefined}
      tabIndex={clickableAction ? 0 : undefined}
      onClick={clickableAction}
      onKeyDown={(event) => {
        if (!clickableAction) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          clickableAction();
        }
      }}
    >
      {hasFlowLeftHandle ? (
        <Handle
          id="left-link"
          type={data.kind === "create" ? "source" : "target"}
          position={Position.Left}
          className="node-link-handle node-link-handle--flow"
        />
      ) : null}
      {hasDeleteLeftHandle ? (
        <Handle
          id="delete-left"
          type="target"
          position={Position.Left}
          className="node-link-handle node-link-handle--danger"
        />
      ) : null}
      {hasModelTargetHandle ? (
        <Handle
          id="model-left"
          type="target"
          position={Position.Left}
          className="node-link-handle node-link-handle--model"
        />
      ) : null}
      {ContentComponent ? <ContentComponent data={data} /> : null}
      {hasDeleteRightHandle ? (
        <Handle
          id="delete-right"
          type="source"
          position={Position.Right}
          className="node-link-handle node-link-handle--danger"
        />
      ) : null}
      {hasModelSourceHandle ? (
        <Handle
          id="model-left-source"
          type="source"
          position={Position.Left}
          className="node-link-handle node-link-handle--model"
        />
      ) : null}
    </div>
  );
}
