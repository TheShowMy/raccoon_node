import type { WorkbenchKind } from "../api/types";
import type { Point, Size } from "./geometry";

/**
 * 外层固定逻辑布局（FE-CANVAS-001/004/005，纯函数）：
 * 六个能力节点两列环绕，中央对话宿主占据主要空间；
 * 窗口变窄先压缩环绕区（侧栏宽度与摘要），不先挤压中央可操作区。
 */

export const CAPABILITY_KINDS = [
  "delivery",
  "files",
  "git",
  "terminal",
  "usage",
  "settings",
] as const satisfies readonly WorkbenchKind[];

export const CAPABILITY_LABELS: Record<WorkbenchKind, string> = {
  delivery: "需求交付",
  files: "文件",
  git: "Git",
  terminal: "终端",
  usage: "用量统计",
  settings: "设置",
};

export const capabilityNodeId = (kind: WorkbenchKind) => `cap-${kind}`;
export const workbenchNodeId = (kind: WorkbenchKind) => `workbench-${kind}`;
export const CENTRAL_NODE_ID = "central-conversation";

const OUTER_MARGIN = 16;
const COLUMN_GAP = 24;
const CAPABILITY_HEIGHT = 128;
const CAPABILITY_GAP = 16;
const CENTRAL_MIN_WIDTH = 480;
const CENTRAL_MIN_HEIGHT = 420;

export type CapabilityPlacement = {
  kind: WorkbenchKind;
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MainLayout = {
  canvasCenter: Point;
  central: {
    nodeId: string;
    x: number;
    y: number;
    width: number;
    height: number;
  };
  capabilities: CapabilityPlacement[];
};

/** 侧栏宽度：随窗口收窄（160→232），为中央区让步（FE-CANVAS-005） */
export function sideColumnWidth(screenWidth: number): number {
  return Math.max(160, Math.min(232, screenWidth * 0.15));
}

export function computeMainLayout(screen: Size): MainLayout {
  const side = sideColumnWidth(screen.width);
  const centralWidth = Math.max(
    CENTRAL_MIN_WIDTH,
    screen.width - 2 * (OUTER_MARGIN + side + COLUMN_GAP),
  );
  const centralHeight = Math.max(
    CENTRAL_MIN_HEIGHT,
    screen.height - OUTER_MARGIN * 2,
  );
  const centralX = (screen.width - centralWidth) / 2;
  const centralY = (screen.height - centralHeight) / 2;

  const columnHeight = 3 * CAPABILITY_HEIGHT + 2 * CAPABILITY_GAP;
  const columnTop = Math.max(OUTER_MARGIN, (screen.height - columnHeight) / 2);
  const leftX = OUTER_MARGIN;
  const rightX = screen.width - OUTER_MARGIN - side;

  const capabilities: CapabilityPlacement[] = CAPABILITY_KINDS.map(
    (kind, index) => {
      const column = index < 3 ? 0 : 1;
      const row = index % 3;
      return {
        kind,
        nodeId: capabilityNodeId(kind),
        x: column === 0 ? leftX : rightX,
        y: columnTop + row * (CAPABILITY_HEIGHT + CAPABILITY_GAP),
        width: side,
        height: CAPABILITY_HEIGHT,
      };
    },
  );

  return {
    canvasCenter: { x: screen.width / 2, y: screen.height / 2 },
    central: {
      nodeId: CENTRAL_NODE_ID,
      x: centralX,
      y: centralY,
      width: centralWidth,
      height: centralHeight,
    },
    capabilities,
  };
}

/** 中央对话宿主投影占比（FE-CANVAS-004：1440×900 下 ≥62% 宽 / ≥72% 高） */
export function centralAreaRatio(screen: Size): {
  widthRatio: number;
  heightRatio: number;
} {
  const layout = computeMainLayout(screen);
  return {
    widthRatio: layout.central.width / screen.width,
    heightRatio: layout.central.height / screen.height,
  };
}

/** 工作台尺寸：需求交付保持原尺寸；普通工具页按连续分栏需要扩展。 */
export function workbenchSizeFor(kind: WorkbenchKind, screen: Size): Size {
  switch (kind) {
    case "delivery":
      return {
        width: Math.min(1380, screen.width * 0.94),
        height: Math.min(820, screen.height * 0.9),
      };
    case "files":
    case "git":
    case "usage":
    case "settings":
      return {
        width: Math.min(1180, screen.width * 0.86),
        height: Math.min(760, screen.height * 0.86),
      };
    case "terminal":
      return {
        width: Math.min(1100, screen.width * 0.84),
        height: Math.min(720, screen.height * 0.84),
      };
  }
}
