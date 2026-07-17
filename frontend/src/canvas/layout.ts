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
  "models",
  "settings",
] as const satisfies readonly WorkbenchKind[];

export const CAPABILITY_LABELS: Record<WorkbenchKind, string> = {
  delivery: "需求交付",
  files: "文件",
  git: "Git",
  terminal: "终端",
  models: "模型与用量",
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

/** 工作台尺寸：需求交付最大可用（FE-DELIVERY-001），其余按内容密度取中大型 */
export function workbenchSizeFor(kind: WorkbenchKind, screen: Size): Size {
  switch (kind) {
    case "delivery":
      return {
        width: Math.min(1120, screen.width * 0.82),
        height: Math.min(720, screen.height * 0.84),
      };
    case "files":
    case "git":
    case "models":
      return {
        width: Math.min(980, screen.width * 0.78),
        height: Math.min(620, screen.height * 0.8),
      };
    case "terminal":
    case "settings":
      return {
        width: Math.min(860, screen.width * 0.72),
        height: Math.min(600, screen.height * 0.78),
      };
  }
}
