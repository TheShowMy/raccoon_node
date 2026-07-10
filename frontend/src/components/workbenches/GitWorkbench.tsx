import ProjectGitNode from "../nodes/ProjectGitNode";
import type { StartNodeData } from "../../types/api";

type GitData = Extract<StartNodeData, { kind: "project-git" }>;

export default function GitWorkbench({ data }: { data: GitData }) {
  return <ProjectGitNode data={data} />;
}
