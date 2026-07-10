import ProjectTerminalNode from "../nodes/ProjectTerminalNode";
import type { StartNodeData } from "../../types/api";

type TerminalData = Extract<StartNodeData, { kind: "project-terminal" }>;

export default function TerminalWorkbench({ data }: { data: TerminalData }) {
  return <ProjectTerminalNode data={data} />;
}
