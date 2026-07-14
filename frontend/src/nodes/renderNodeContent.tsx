import React from "react";
import type { StartNodeData } from "../types/api";
import ProjectTerminalNode from "../components/nodes/ProjectTerminalNode";
import AstryxChatSurface from "../components/astryx-chat/AstryxChatSurface";
import WorkflowRunNode from "../components/nodes/WorkflowRunNode";
import RequirementListNode from "../components/nodes/RequirementListNode";
import TokenUsageNode from "../components/nodes/TokenUsageNode";
import ProjectGitNode from "../components/nodes/ProjectGitNode";
import ProjectSettingsNode from "../components/nodes/ProjectSettingsNode";
import WorkflowItemNode from "../components/nodes/WorkflowItemNode";

function assertNever(value: never): never {
  throw new Error(`Unexpected node kind: ${String(value)}`);
}

export function renderNodeContent(data: StartNodeData): React.JSX.Element {
  switch (data.kind) {
    case "project-settings":
      return <ProjectSettingsNode data={data} />;
    case "requirement-chat":
      return <AstryxChatSurface data={data} />;
    case "project-terminal":
      return <ProjectTerminalNode data={data} />;
    case "project-git":
      return <ProjectGitNode data={data} />;
    case "workflow-run":
      return <WorkflowRunNode data={data} />;
    case "requirement-list":
      return <RequirementListNode data={data} />;
    case "workflow-item":
      return <WorkflowItemNode data={data} />;
    case "token-usage":
      return <TokenUsageNode data={data} />;
    default:
      return assertNever(data);
  }
}
