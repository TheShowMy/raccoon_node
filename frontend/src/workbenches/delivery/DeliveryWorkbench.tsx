import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { memo, useEffect, useMemo, useRef } from "react";
import { useMatch } from "react-router-dom";
import { groupRequirements } from "../../api/groups";
import { useCanvasStore, type Viewport } from "../../store/canvasStore";
import { useDeliveryStore } from "../../store/deliveryStore";
import { useDomainStore } from "../../store/domainStore";
import { DevScenarioBar } from "./DevScenarioBar";
import {
  ActionConfirmationNode,
  ActionResultNode,
  DiffNode,
  DiagnosticsNode,
  PlanInvalidNode,
  PublicationNode,
  RequirementListNode,
  RequirementSummaryNode,
  ReviewNode,
  RunNode,
  StageBandNode,
  ValidationNode,
  WorkItemNode,
  WorkPlanNode,
} from "./nodes";
import {
  deliveryNodeId,
  projectDelivery,
  type DeliveryFlowNode,
} from "./projection";

const nodeTypes = {
  requirement_list: RequirementListNode,
  requirement_summary: RequirementSummaryNode,
  run: RunNode,
  work_plan: WorkPlanNode,
  plan_invalid: PlanInvalidNode,
  stage_band: StageBandNode,
  work_item: WorkItemNode,
  diff: DiffNode,
  validation: ValidationNode,
  review: ReviewNode,
  publication: PublicationNode,
  diagnostics: DiagnosticsNode,
  action_confirmation: ActionConfirmationNode,
  action_result: ActionResultNode,
};

/** 固定缩放：禁止双击/滚轮/捏合缩放，聚焦统一使用此缩放级别。 */
const FIXED_ZOOM = 0.9;

const DEFAULT_VIEWPORT: Viewport = { x: 24, y: 24, zoom: FIXED_ZOOM };

/** 悬浮「回到 Run」指示：方向箭头 + 吸附到容器边缘的按钮中心坐标。 */
export type OffscreenIndicator = {
  arrow: string;
  x: number;
  y: number;
};

const DIRECTION_ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];

/**
 * Run 节点完全不在可视区时，返回可视区中心指向节点中心的 8 方向指示；
 * 可见（含部分可见）或 pane 未测量时返回 null。
 */
export function runNodeOffscreen({
  viewport,
  pane,
  node,
  margin = 40,
}: {
  viewport: Viewport;
  pane: { width: number; height: number };
  node: { x: number; y: number; width: number; height: number };
  margin?: number;
}): OffscreenIndicator | null {
  // 过渡动画中途可能出现 NaN（jsdom / d3 插值），该帧直接隐藏
  if (
    ![
      viewport.x,
      viewport.y,
      viewport.zoom,
      pane.width,
      pane.height,
      node.x,
      node.y,
      node.width,
      node.height,
    ].every(Number.isFinite)
  ) {
    return null;
  }
  if (pane.width <= 0 || pane.height <= 0) return null;
  const left = node.x * viewport.zoom + viewport.x;
  const top = node.y * viewport.zoom + viewport.y;
  const right = left + node.width * viewport.zoom;
  const bottom = top + node.height * viewport.zoom;
  const visible =
    left < pane.width && right > 0 && top < pane.height && bottom > 0;
  if (visible) return null;
  const cx = left + (right - left) / 2;
  const cy = top + (bottom - top) / 2;
  const dx = cx - pane.width / 2;
  const dy = cy - pane.height / 2;
  const sector = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
  return {
    arrow: DIRECTION_ARROWS[sector],
    x: Math.min(Math.max(cx, margin), pane.width - margin),
    y: Math.min(Math.max(cy, margin), pane.height - margin),
  };
}

/**
 * 需求交付工作台（FE-DELIVERY-001）：扣除最小标题栏后内部 React Flow 铺满。
 * 照 ConversationGraph 范式：嵌套受控 viewport 的 React Flow，
 * 领域投影 → 节点/边，UI 只是投影（02 §9.1）。
 */
const DeliveryCanvas = memo(function DeliveryCanvas() {
  const rf = useReactFlow();
  const requirements = useDomainStore((state) => state.requirements);
  const revisions = useDomainStore((state) => state.revisions);
  const runs = useDomainStore((state) => state.runs);
  const plans = useDomainStore((state) => state.plans);
  const validations = useDomainStore((state) => state.validations);
  const reviews = useDomainStore((state) => state.reviews);
  const publications = useDomainStore((state) => state.publications);
  const actions = useDomainStore((state) => state.actions);

  const selectedRequirementId = useDeliveryStore(
    (state) => state.selectedRequirementId,
  );
  const focusRequest = useDeliveryStore((state) => state.focusRequest);
  const diagnosticsRunId = useDeliveryStore((state) => state.diagnosticsRunId);
  const deliveryFocusRequest = useCanvasStore(
    (state) => state.deliveryFocusRequest,
  );

  /* 深链（02 §3.3）：/delivery/requirements/:id 与 /delivery/runs/:id */
  const requirementMatch = useMatch(
    "/canvas/workbenches/delivery/requirements/:requirementId",
  );
  const runMatch = useMatch("/canvas/workbenches/delivery/runs/:runId");
  const deepRequirementId = requirementMatch?.params.requirementId ?? null;
  const deepRunId = runMatch?.params.runId ?? null;

  useEffect(() => {
    const store = useDeliveryStore.getState();
    if (deepRunId) {
      const run = useDomainStore.getState().runs[deepRunId];
      if (run) {
        store.selectRequirement(run.requirement_id);
        store.requestFocus(deliveryNodeId.run(deepRunId));
      }
      return;
    }
    if (deepRequirementId) {
      const requirement =
        useDomainStore.getState().requirements[deepRequirementId];
      if (!requirement) return;
      const visible = groupRequirements([requirement], runs).length > 0;
      if (!visible) return;
      store.selectRequirement(deepRequirementId);
      const target = requirement.latest_run_id
        ? deliveryNodeId.run(requirement.latest_run_id)
        : deliveryNodeId.requirement(deepRequirementId);
      store.requestFocus(target);
    }
  }, [deepRequirementId, deepRunId]);

  /* 打开定位（每次挂载一次，深链优先）：有运行中任务聚焦其 Run；
     没有运行中任务不自动展开 DAG，锚定需求列表节点。 */
  const initialPlacementDone = useRef(false);
  useEffect(() => {
    if (initialPlacementDone.current) return;
    if (deepRequirementId || deepRunId) {
      initialPlacementDone.current = true;
      return;
    }
    const store = useDeliveryStore.getState();
    if (store.selectedRequirementId) {
      // 恢复了上次选中：交给选中聚焦 effect 处理
      initialPlacementDone.current = true;
      return;
    }
    const all = Object.values(requirements);
    if (all.length === 0) return; // 等待领域数据
    const visible = groupRequirements(all, runs).flatMap(
      (group) => group.items,
    );
    const running = visible.find((requirement) => {
      const run = requirement.latest_run_id
        ? runs[requirement.latest_run_id]
        : undefined;
      return run && run.phase !== "terminal";
    });
    initialPlacementDone.current = true;
    if (running?.latest_run_id) {
      store.selectRequirement(running.id);
      store.requestFocus(deliveryNodeId.run(running.latest_run_id));
    } else {
      store.requestFocus(deliveryNodeId.list());
    }
  }, [deepRequirementId, deepRunId, requirements, runs]);

  /* 选中需求从可见列表消失时收起，不再改选其他需求 */
  useEffect(() => {
    const selected = useDeliveryStore.getState().selectedRequirementId;
    if (!selected) return;
    const visible = groupRequirements(
      Object.values(requirements),
      runs,
    ).flatMap((group) => group.items);
    if (!visible.some((entry) => entry.id === selected)) {
      useDeliveryStore.getState().selectRequirement(null);
    }
  }, [requirements, runs]);

  /* 选中即定位：有 Run 聚焦 Run 节点；已确认未执行则聚焦需求摘要。 */
  const selectedRequirement = selectedRequirementId
    ? requirements[selectedRequirementId]
    : undefined;
  const selectedRunId = selectedRequirement?.latest_run_id ?? null;
  useEffect(() => {
    if (!selectedRequirementId) return;
    if (!useDomainStore.getState().requirements[selectedRequirementId]) return;
    useDeliveryStore
      .getState()
      .requestFocus(
        selectedRunId
          ? deliveryNodeId.run(selectedRunId)
          : deliveryNodeId.requirement(selectedRequirementId),
      );
  }, [selectedRequirementId, selectedRunId]);

  const projection = useMemo(
    () =>
      projectDelivery({
        requirements,
        revisions,
        runs,
        plans,
        validations,
        reviews,
        publications,
        actions,
        selectedRequirementId,
        diagnosticsRunId,
      }),
    [
      requirements,
      revisions,
      runs,
      plans,
      validations,
      reviews,
      publications,
      actions,
      selectedRequirementId,
      diagnosticsRunId,
    ],
  );
  const nodes: DeliveryFlowNode[] = projection.nodes;

  /* 一次性聚焦请求（深链 / GrayDango 定位 / 打开定位 / 回到 Run） */
  useEffect(() => {
    const localNodeId = focusRequest?.nodeId ?? null;
    const globalNodeId = deliveryFocusRequest?.node_id ?? null;
    const requestedNodeId = localNodeId ?? globalNodeId;
    if (!requestedNodeId) return;
    const exactTarget = nodes.find((node) => node.id === requestedNodeId);
    // 深链/状态跃迁的精确目标尚未投影时继续等待，不能把请求消费在列表锚点。
    if (localNodeId && !exactTarget) return;
    const target =
      exactTarget ?? nodes.find((node) => /diag/.test(node.id)) ?? nodes[0];
    if (target) {
      const width =
        typeof target.style?.width === "number" ? target.style.width : 200;
      void rf.setCenter(
        target.position.x + width / 2,
        target.position.y + 120,
        { zoom: FIXED_ZOOM, duration: 320 },
      );
    }
    if (focusRequest) useDeliveryStore.getState().clearFocus();
    if (deliveryFocusRequest) {
      useCanvasStore
        .getState()
        .consumeDeliveryFocus(deliveryFocusRequest.request_id);
    }
  }, [deliveryFocusRequest, focusRequest, nodes, rf]);

  const viewport = useCanvasStore(
    (state) => state.deliveryViewport ?? DEFAULT_VIEWPORT,
  );

  return (
    <div className="delivery-canvas nodrag nowheel">
      <ReactFlow
        nodes={nodes}
        edges={projection.edges}
        nodeTypes={nodeTypes}
        viewport={viewport}
        onViewportChange={(next) =>
          useCanvasStore.getState().saveDeliveryViewport(next)
        }
        onNodeClick={() => {
          // XYFlow：无 flow 级 onNodeClick 时节点包装层不启用 pointer-events，
          // 子画布全部点击会穿透（与 MainCanvas 同一规则）；节点选择经节点内按钮完成。
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        minZoom={FIXED_ZOOM}
        maxZoom={FIXED_ZOOM}
        proOptions={{ hideAttribution: true }}
        aria-label="需求交付子画布"
      />
      <ReturnToRunButton nodes={nodes} />
      {import.meta.env.VITE_ENABLE_DEMO_CONSOLE === "true" ? (
        <DevScenarioBar />
      ) : null}
    </div>
  );
});

export const DeliveryWorkbench = memo(function DeliveryWorkbench() {
  return (
    <ReactFlowProvider>
      <DeliveryCanvas />
    </ReactFlowProvider>
  );
});

/* ── 悬浮「回到 Run」：Run 节点完全移出可视区时按方向吸附边缘 ── */

const RUN_NODE_FALLBACK_SIZE = { width: 360, height: 320 };

function ReturnToRunButton({ nodes }: { nodes: DeliveryFlowNode[] }) {
  const runNode = nodes.find((node) => node.type === "run") ?? null;
  const runNodeId = runNode?.id ?? null;
  const transform = useStore((state) => state.transform);
  const paneWidth = useStore((state) => state.width);
  const paneHeight = useStore((state) => state.height);
  const measured = useStore((state) =>
    runNodeId ? state.nodeLookup.get(runNodeId)?.measured : undefined,
  );
  if (!runNode || paneWidth <= 0 || paneHeight <= 0) return null;
  const indicator = runNodeOffscreen({
    viewport: { x: transform[0], y: transform[1], zoom: transform[2] },
    pane: { width: paneWidth, height: paneHeight },
    node: {
      x: runNode.position.x,
      y: runNode.position.y,
      width: measured?.width ?? RUN_NODE_FALLBACK_SIZE.width,
      height: measured?.height ?? RUN_NODE_FALLBACK_SIZE.height,
    },
  });
  if (!indicator) return null;
  return (
    <button
      type="button"
      className="delivery-canvas__return-run nodrag nowheel"
      style={{ left: indicator.x, top: indicator.y }}
      aria-label="回到 Run 节点"
      onClick={() => useDeliveryStore.getState().requestFocus(runNode.id)}
    >
      {indicator.arrow} Run
    </button>
  );
}
