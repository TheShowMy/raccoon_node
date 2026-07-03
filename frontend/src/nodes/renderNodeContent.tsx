import React from "react";
import type { StartNodeData } from "../types/api";
import ProjectGithubNode from "../components/nodes/ProjectGithubNode";
import ProjectTerminalNode from "../components/nodes/ProjectTerminalNode";
import RequirementChatNode from "../components/nodes/RequirementChatNode";
import RequirementDagNode from "../components/nodes/RequirementDagNode";
import RequirementListNode from "../components/nodes/RequirementListNode";
import RequirementTaskNode from "../components/nodes/RequirementTaskNode";
import TokenUsageNode from "../components/nodes/TokenUsageNode";
import ProjectGitNode from "../components/nodes/ProjectGitNode";
import ProjectSettingsNode from "../components/nodes/ProjectSettingsNode";

function assertNever(value: never): never {
  throw new Error(`Unexpected node kind: ${String(value)}`);
}

export function renderNodeContent(data: StartNodeData): React.JSX.Element {
  switch (data.kind) {
    case "project-settings":
      return <ProjectSettingsNode data={data} />;
    case "project-github":
      return <ProjectGithubNode data={data} />;
    case "requirement-chat":
      return <RequirementChatNode data={data} />;
    case "project-terminal":
      return <ProjectTerminalNode data={data} />;
    case "project-git":
      return <ProjectGitNode data={data} />;
    case "requirement-dag":
      return <RequirementDagNode data={data} />;
    case "requirement-list":
      return <RequirementListNode data={data} />;
    case "requirement-task":
      return <RequirementTaskNode data={data} />;
    case "token-usage":
      return <TokenUsageNode data={data} />;
    default:
      return assertNever(data);
  }
}
