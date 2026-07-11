import { memo, type ReactNode } from "react";
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

export interface CanvasSize {
  width: number;
  height: number;
}

export interface BuildOrbitNodesInput {
  activePanel: MainPanelKind | null;
  gitBranch: string | null;
  modelRpcStatus: string;
  requirementCount: number;
  terminalCount: number;
  tokenContextPercent: number;
  onOpen: (panel: MainPanelKind) => void;
  onPrefetch?: (panel: MainPanelKind) => void;
  canvasSize?: CanvasSize;
}

const CHAT_NODE_BOUNDS = { x: 0, y: 0, width: 960, height: 760 };
const ORBIT_NODE_SIZE = { width: 190, height: 88 };
// Extra clearance added to the chat-node bounding box so orbit nodes never
// overlap the chat node or each other, even on small viewports.
const MIN_ORBIT_PADDING = 220;

type OrbitAnchor =
  | { side: "top"; offset: number }
  | { side: "right"; offset: number }
  | { side: "bottom"; offset: number }
  | { side: "left"; offset: number };

const ORBIT_DEFINITIONS: Array<{
  id: string;
  kind: MainPanelKind;
  title: string;
  anchor: OrbitAnchor;
  icon: ReactNode;
  detail: (input: BuildOrbitNodesInput) => string;
}> = [
  {
    id: "orbit-settings",
    kind: "settings",
    title: "设置",
    anchor: { side: "top", offset: 0.5 },
    icon: <Settings size={20} />,
    detail: (input) => input.modelRpcStatus,
  },
  {
    id: "orbit-terminal",
    kind: "terminal",
    title: "终端",
    anchor: { side: "right", offset: 0.25 },
    icon: <TerminalSquare size={20} />,
    detail: (input) => `${input.terminalCount} 个会话`,
  },
  {
    id: "orbit-git",
    kind: "git",
    title: "Git",
    anchor: { side: "right", offset: 0.75 },
    icon: <GitBranch size={20} />,
    detail: (input) => input.gitBranch ?? "读取状态",
  },
  {
    id: "orbit-tokens",
    kind: "tokens",
    title: "Token",
    anchor: { side: "bottom", offset: 0.5 },
    icon: <Gauge size={20} />,
    detail: (input) => `${input.tokenContextPercent}% context`,
  },
  {
    id: "orbit-requirements",
    kind: "requirements",
    title: "需求列表",
    anchor: { side: "left", offset: 0.75 },
    icon: <ListTodo size={20} />,
    detail: (input) => `${input.requirementCount} 个需求`,
  },
  {
    id: "orbit-files",
    kind: "files",
    title: "文件",
    anchor: { side: "left", offset: 0.25 },
    icon: <Files size={20} />,
    detail: () => "搜索与预览",
  },
];

export const OrbitNode = memo(function OrbitNode({
  data,
}: NodeProps<Node<OrbitNodeData>>) {
  return (
    <Button
      label={`${data.title} · ${data.detail}`}
      icon={data.icon}
      variant={data.active ? "primary" : "secondary"}
      className={`orbit-tool-button nodrag ${
        data.active ? "orbit-tool-button--active" : ""
      }`}
      onClick={data.onOpen}
      onMouseEnter={data.onPrefetch}
      onFocus={data.onPrefetch}
    />
  );
});

interface OrbitRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function buildOrbitRect(canvasSize: CanvasSize): OrbitRect {
  const minDimension = Math.max(
    1,
    Math.min(canvasSize.width, canvasSize.height),
  );
  // Padding scales with the smaller viewport dimension but never shrinks below
  // a comfortable margin around the 960×760 chat node.
  const padding = Math.max(MIN_ORBIT_PADDING, minDimension * 0.14);
  return {
    left: CHAT_NODE_BOUNDS.x - padding,
    top: CHAT_NODE_BOUNDS.y - padding,
    right: CHAT_NODE_BOUNDS.x + CHAT_NODE_BOUNDS.width + padding,
    bottom: CHAT_NODE_BOUNDS.y + CHAT_NODE_BOUNDS.height + padding,
  };
}

function orbitPosition(
  anchor: OrbitAnchor,
  canvasSize: CanvasSize,
): { x: number; y: number } {
  const rect = buildOrbitRect(canvasSize);
  const halfW = ORBIT_NODE_SIZE.width / 2;
  const halfH = ORBIT_NODE_SIZE.height / 2;
  const spanX = rect.right - rect.left;
  const spanY = rect.bottom - rect.top;

  switch (anchor.side) {
    case "top":
      return {
        x: rect.left + spanX * anchor.offset - halfW,
        y: rect.top - halfH,
      };
    case "right":
      return {
        x: rect.right - halfW,
        y: rect.top + spanY * anchor.offset - halfH,
      };
    case "bottom":
      return {
        x: rect.left + spanX * anchor.offset - halfW,
        y: rect.bottom - halfH,
      };
    case "left":
      return {
        x: rect.left - halfW,
        y: rect.top + spanY * anchor.offset - halfH,
      };
  }
}

export function buildOrbitNodes({
  activePanel,
  onOpen,
  onPrefetch,
  canvasSize,
  ...detailInput
}: BuildOrbitNodesInput): Node<OrbitNodeData>[] {
  const fallback =
    !canvasSize || canvasSize.width === 0 || canvasSize.height === 0;

  return ORBIT_DEFINITIONS.map((definition) => {
    const position = fallback
      ? staticOrbitPosition(definition.id)
      : orbitPosition(definition.anchor, canvasSize as CanvasSize);
    return {
      id: definition.id,
      type: "orbitNode",
      position,
      style: {
        width: ORBIT_NODE_SIZE.width,
        height: ORBIT_NODE_SIZE.height,
        pointerEvents: "all",
      },
      data: {
        title: definition.title,
        detail: definition.detail({
          activePanel,
          onOpen,
          onPrefetch,
          canvasSize,
          ...detailInput,
        } as BuildOrbitNodesInput),
        icon: definition.icon,
        active: activePanel === definition.kind,
        onOpen: () => onOpen(definition.kind),
        onPrefetch: onPrefetch ? () => onPrefetch(definition.kind) : undefined,
      },
      draggable: false,
    };
  });
}

function staticOrbitPosition(id: string): { x: number; y: number } {
  // Fallback layout that mirrors the dynamic bounding-box placement for a
  // 1920×1080 viewport with the current padding and offsets.
  switch (id) {
    case "orbit-settings":
      return { x: 385, y: -264 };
    case "orbit-terminal":
      return { x: 1085, y: 36 };
    case "orbit-git":
      return { x: 1085, y: 636 };
    case "orbit-tokens":
      return { x: 385, y: 936 };
    case "orbit-requirements":
      return { x: -315, y: 636 };
    case "orbit-files":
      return { x: -315, y: 36 };
    default:
      return { x: 0, y: 0 };
  }
}
