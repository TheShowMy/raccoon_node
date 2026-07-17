import { useQuery } from "@tanstack/react-query";
import { PixelButton } from "@pxlkit/ui-kit";
import type { NodeProps } from "@xyflow/react";
import { memo, type ComponentType } from "react";
import { getApi } from "../api";
import type { WorkbenchKind } from "../api/types";
import { ConversationGraph } from "../chat/ConversationGraph";
import { DeliveryWorkbench } from "../workbenches/delivery/DeliveryWorkbench";
import "../workbenches/delivery/delivery.css";
import { FilesWorkbench } from "../workbenches/files/FilesWorkbench";
import { GitWorkbench } from "../workbenches/git/GitWorkbench";
import { ModelsWorkbench } from "../workbenches/models/ModelsWorkbench";
import { SettingsWorkbench } from "../workbenches/settings/SettingsWorkbench";
import { TerminalWorkbench } from "../workbenches/terminal/TerminalWorkbench";
import "../workbenches/workbench.css";
import { CAPABILITY_LABELS, capabilityNodeId } from "./layout";
import { PixelIcon } from "./pixelIcons";

/* ── 环绕能力概览卡（FE-CANVAS-002：可访问名称 + ≤3 条摘要 + Enter 打开） ── */

export type CapabilityNodeData = {
  kind: WorkbenchKind;
  dimmed: boolean;
  onOpen: (kind: WorkbenchKind) => void;
};

export const CapabilityNode = memo(function CapabilityNode({
  data,
}: NodeProps) {
  const { kind, dimmed, onOpen } = data as CapabilityNodeData;
  const { data: summary } = useQuery({
    queryKey: ["workbench-summary", kind],
    queryFn: () => getApi().getWorkbenchSummary(kind),
    staleTime: 60_000,
  });
  const title = CAPABILITY_LABELS[kind];
  return (
    <div
      className="capability-node px-cut px-shadowed-sm"
      data-dimmed={dimmed || undefined}
      role="button"
      tabIndex={dimmed ? -1 : 0}
      aria-label={`${title}工作台，按 Enter 打开`}
      data-capability-trigger={capabilityNodeId(kind)}
      onKeyDown={(event) => {
        // 点击由 flow 级 onNodeClick 路由（见 MainCanvas），这里只保留键盘打开
        if (dimmed) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(kind);
        }
      }}
    >
      <h3 className="px-font-pixel capability-node__title">
        <PixelIcon name={kind} size={14} />
        {title}
      </h3>
      <ul className="capability-node__lines">
        {(summary?.lines ?? ["加载中…"]).slice(0, 3).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
});

/* ── 中央对话宿主节点 ── */

export type CentralNodeData = { dimmed: boolean };

export const CentralConversationNode = memo(function CentralConversationNode({
  data,
}: NodeProps) {
  const { dimmed } = data as CentralNodeData;
  return (
    <div
      className="central-node px-cut px-shadowed"
      data-dimmed={dimmed || undefined}
      aria-label="中央对话图"
      aria-hidden={dimmed || undefined}
    >
      <ConversationGraph />
    </div>
  );
});

/* ── 射线工作台节点（FE-CANVAS-013：最小标题 + 关闭控制） ── */

const WORKBENCH_CONTENT: Record<WorkbenchKind, ComponentType> = {
  delivery: DeliveryWorkbench,
  files: FilesWorkbench,
  git: GitWorkbench,
  terminal: TerminalWorkbench,
  models: ModelsWorkbench,
  settings: SettingsWorkbench,
};

/** 设置是表单密集型常规布局（02 §2.2 不强行画布化）；其余为全铺满子画布 */
const FULL_FILL: Record<WorkbenchKind, boolean> = {
  delivery: true,
  files: true,
  git: true,
  terminal: true,
  models: true,
  settings: false,
};

export type WorkbenchNodeData = {
  kind: WorkbenchKind;
  onClose: () => void;
};

export const CanvasWorkbenchNode = memo(function CanvasWorkbenchNode({
  data,
}: NodeProps) {
  const { kind, onClose } = data as WorkbenchNodeData;
  const title = CAPABILITY_LABELS[kind];
  const Content = WORKBENCH_CONTENT[kind];
  return (
    <section
      className="workbench-node px-cut px-shadowed"
      aria-label={`${title}工作台`}
      data-workbench={kind}
    >
      <header className="workbench-node__header">
        <h2 className="px-font-pixel workbench-node__title">{title}</h2>
        <PixelButton
          size="sm"
          tone="red"
          variant="outline"
          aria-label={`关闭${title}工作台`}
          onClick={onClose}
        >
          关闭 Esc
        </PixelButton>
      </header>
      {/* FE-DELIVERY-001：需求工作台扣除最小标题栏后内部 React Flow 铺满 */}
      <div
        className="workbench-node__body nodrag nowheel"
        data-fill={FULL_FILL[kind] ? true : undefined}
      >
        <Content />
      </div>
    </section>
  );
});
