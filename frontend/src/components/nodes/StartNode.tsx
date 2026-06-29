import React, { useState, useRef, useEffect } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { StartNodeData } from "../../types/api";
import { renderNodeContent } from "../../nodes/renderNodeContent";
import { githubUrlFromGitUrl } from "../../utils/format";

function StartNode({ data }: NodeProps<Node<StartNodeData>>) {
  const projectGithubUrl =
    data.kind === "project-github"
      ? githubUrlFromGitUrl(data.project.git_url)
      : null;
  const clickableAction =
    data.kind === "summary"
      ? data.onAction
      : projectGithubUrl
        ? () => window.open(projectGithubUrl, "_blank", "noopener,noreferrer")
        : undefined;
  const hasSettingsSourceHandle =
    data.kind === "summary" && data.icon === "model";
  const hasSettingsListTargetHandle = data.kind === "settings-list";
  const hasSettingsListSourceHandle = data.kind === "settings-list";
  const hasSettingsDetailTargetHandle =
    data.kind === "model-config" || data.kind === "basic-settings";
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
        clickableAction ? "node-card--clickable" : ""
      } ${data.kind === "project-github" ? "compact" : ""}`}
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
      {hasSettingsListTargetHandle ? (
        <Handle
          id="settings-list-right"
          type="target"
          position={Position.Right}
          className="node-link-handle node-link-handle--model"
        />
      ) : null}
      {hasSettingsDetailTargetHandle ? (
        <Handle
          id="settings-detail-right"
          type="target"
          position={Position.Right}
          className="node-link-handle node-link-handle--model"
        />
      ) : null}
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
      {hasSettingsListSourceHandle ? (
        <Handle
          id="settings-list-left-source"
          type="source"
          position={Position.Left}
          className="node-link-handle node-link-handle--model"
        />
      ) : null}
      {hasSettingsSourceHandle ? (
        <Handle
          id="settings-left-source"
          type="source"
          position={Position.Left}
          className="node-link-handle node-link-handle--model"
        />
      ) : null}
    </div>
  );
}

export default React.memo(StartNode);
