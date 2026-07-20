import { useQuery } from "@tanstack/react-query";
import { PixelButton } from "@pxlkit/ui-kit";
import type { NodeProps } from "@xyflow/react";
import { memo, useEffect, useRef, type ComponentType } from "react";
import { getApi } from "../api";
import type { WorkbenchKind } from "../api/types";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { persistScrollPosition, restoreScrollPositions } from "./nodeScroll";
import { ConversationGraph } from "../chat/ConversationGraph";
import { DeliveryWorkbench } from "../workbenches/delivery/DeliveryWorkbench";
import "../workbenches/delivery/delivery.css";
import { FilesWorkbench } from "../workbenches/files/FilesWorkbench";
import { GitWorkbench } from "../workbenches/git/GitWorkbench";
import { UsageWorkbench } from "../workbenches/usage/UsageWorkbench";
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
  const {
    data: summary,
    isLoading,
    isError,
  } = useQuery({
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
        {isError ? (
          <li>摘要获取失败</li>
        ) : isLoading || !summary ? (
          <li className="capability-node__line--loading">加载中…</li>
        ) : (
          summary.lines
            .slice(0, 3)
            .map((line, index) => <li key={`${kind}-${index}`}>{line}</li>)
        )}
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
      <ErrorBoundary title="对话">
        <ConversationGraph />
      </ErrorBoundary>
    </div>
  );
});

/* ── 射线工作台节点（FE-CANVAS-013：最小标题 + 关闭控制） ── */

const WORKBENCH_CONTENT: Record<WorkbenchKind, ComponentType> = {
  delivery: DeliveryWorkbench,
  files: FilesWorkbench,
  git: GitWorkbench,
  terminal: TerminalWorkbench,
  usage: UsageWorkbench,
  settings: SettingsWorkbench,
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (bodyRef.current) {
        restoreScrollPositions(bodyRef.current, `workbench:${kind}`);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [kind]);
  useEffect(() => {
    const timer = scrollDebounceRef.current;
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);
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
      {/* 工作台内容铺满宿主；只有需求工作台在内部继续使用 React Flow。 */}
      <div
        ref={bodyRef}
        className="workbench-node__body nodrag nowheel"
        data-fill
        onScrollCapture={(event) => {
          if (scrollDebounceRef.current) {
            clearTimeout(scrollDebounceRef.current);
          }
          scrollDebounceRef.current = setTimeout(() => {
            persistScrollPosition(event.target, `workbench:${kind}`);
          }, 100);
        }}
      >
        <ErrorBoundary title={title}>
          <Content />
        </ErrorBoundary>
      </div>
    </section>
  );
});
