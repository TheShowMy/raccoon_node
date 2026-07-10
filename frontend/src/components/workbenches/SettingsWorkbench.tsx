import ProjectSettingsNode from "../nodes/ProjectSettingsNode";
import type { StartNodeData } from "../../types/api";

type SettingsData = Extract<StartNodeData, { kind: "project-settings" }>;

export default function SettingsWorkbench({ data }: { data: SettingsData }) {
  return <ProjectSettingsNode data={data} />;
}
