import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import type { Node, NodeProps } from "@xyflow/react";
import {
  Files,
  Gauge,
  GitBranch,
  ListTodo,
  Settings,
  TerminalSquare,
} from "lucide-react";

export type MainPanelKind =
  | "settings"
  | "terminal"
  | "git"
  | "tokens"
  | "requirements"
  | "files";

export type OrbitNodeData = Record<string, unknown> & {
  title: string;
  detail: string;
  icon: ReactNode;
  active: boolean;
  onOpen: () => void;
  onPrefetch?: () => void;
};

export interface BuildOrbitNodesInput {
  activePanel: MainPanelKind | null;
  gitBranch: string | null;
  modelRpcStatus: string;
  requirementCount: number;
  terminalCount: number;
  tokenContextPercent: number;
  onOpen: (panel: MainPanelKind) => void;
  onPrefetch?: (panel: MainPanelKind) => void;
}

export function OrbitNode({ data }: NodeProps<Node<OrbitNodeData>>) {
  return (
    <Button
      label={`${data.title} · ${data.detail}`}
      icon={data.icon}
      variant={data.active ? "primary" : "secondary"}
      className="orbit-tool-button nodrag"
      onClick={data.onOpen}
      onMouseEnter={data.onPrefetch}
      onFocus={data.onPrefetch}
    />
  );
}

export function buildOrbitNodes({
  activePanel,
  gitBranch,
  modelRpcStatus,
  requirementCount,
  terminalCount,
  tokenContextPercent,
  onOpen,
  onPrefetch,
}: BuildOrbitNodesInput): Node<OrbitNodeData>[] {
  const definitions: Array<{
    id: string;
    kind: MainPanelKind;
    title: string;
    detail: string;
    icon: ReactNode;
    position: { x: number; y: number };
  }> = [
    {
      id: "orbit-settings",
      kind: "settings",
      title: "设置",
      detail: modelRpcStatus,
      icon: <Settings size={20} />,
      position: { x: 388, y: -220 },
    },
    {
      id: "orbit-terminal",
      kind: "terminal",
      title: "终端",
      detail: `${terminalCount} 个会话`,
      icon: <TerminalSquare size={20} />,
      position: { x: 1120, y: 80 },
    },
    {
      id: "orbit-git",
      kind: "git",
      title: "Git",
      detail: gitBranch ?? "读取状态",
      icon: <GitBranch size={20} />,
      position: { x: 1220, y: 680 },
    },
    {
      id: "orbit-tokens",
      kind: "tokens",
      title: "Token",
      detail: `${tokenContextPercent}% context`,
      icon: <Gauge size={20} />,
      position: { x: 388, y: 980 },
    },
    {
      id: "orbit-requirements",
      kind: "requirements",
      title: "需求列表",
      detail: `${requirementCount} 个需求`,
      icon: <ListTodo size={20} />,
      position: { x: -430, y: 680 },
    },
    {
      id: "orbit-files",
      kind: "files",
      title: "文件",
      detail: "搜索与预览",
      icon: <Files size={20} />,
      position: { x: -530, y: 80 },
    },
  ];

  return definitions.map((definition) => ({
    id: definition.id,
    type: "orbitNode",
    position: definition.position,
    style: { width: 190, height: 88, pointerEvents: "all" },
    data: {
      title: definition.title,
      detail: definition.detail,
      icon: definition.icon,
      active: activePanel === definition.kind,
      onOpen: () => onOpen(definition.kind),
      onPrefetch: onPrefetch ? () => onPrefetch(definition.kind) : undefined,
    },
    draggable: false,
  }));
}
