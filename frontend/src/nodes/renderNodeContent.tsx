import React from "react";
import type { StartNodeData } from "../types/api";
import ModelConfigNode from "../components/nodes/ModelConfigNode";
import ProjectGithubNode from "../components/nodes/ProjectGithubNode";
import RequirementChatNode from "../components/nodes/RequirementChatNode";
import RequirementDagNode from "../components/nodes/RequirementDagNode";
import RequirementListNode from "../components/nodes/RequirementListNode";
import RequirementTaskNode from "../components/nodes/RequirementTaskNode";
import SummaryCard from "../components/nodes/SummaryCard";
import TokenUsageNode from "../components/nodes/TokenUsageNode";

function assertNever(value: never): never {
  throw new Error(`Unexpected node kind: ${String(value)}`);
}

export function renderNodeContent(data: StartNodeData): React.JSX.Element {
  switch (data.kind) {
    case "model-config":
      return <ModelConfigNode data={data} />;
    case "project-github":
      return <ProjectGithubNode data={data} />;
    case "requirement-chat":
      return <RequirementChatNode data={data} />;
    case "requirement-dag":
      return <RequirementDagNode data={data} />;
    case "requirement-list":
      return <RequirementListNode data={data} />;
    case "requirement-task":
      return <RequirementTaskNode data={data} />;
    case "summary":
      return <SummaryCard data={data} />;
    case "token-usage":
      return <TokenUsageNode data={data} />;
    default:
      return assertNever(data);
  }
}
