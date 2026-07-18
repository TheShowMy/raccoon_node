import { ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
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

const DEFAULT_VIEWPORT: Viewport = { x: 24, y: 24, zoom: 0.8 };

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

  /* 未选中时默认选中第一个需求（FE-DELIVERY-003 从列表锚点开始） */
  useEffect(() => {
    const selected = useDeliveryStore.getState().selectedRequirementId;
    const visible = groupRequirements(
      Object.values(requirements),
      runs,
    ).flatMap((group) => group.items);
    if (selected && visible.some((entry) => entry.id === selected)) return;
    const first = visible[0];
    if (first) useDeliveryStore.getState().selectRequirement(first.id);
    else useDeliveryStore.getState().selectRequirement(null);
  }, [requirements, runs]);

  /* Run 首次生成时先定位 Run；WorkPlan 测量完成后再执行一次流水线 fit。 */
  const selectedRequirement = selectedRequirementId
    ? requirements[selectedRequirementId]
    : undefined;
  const selectedRunId = selectedRequirement?.latest_run_id ?? null;
  useEffect(() => {
    if (!selectedRequirementId) return;
    if (selectedRunId) {
      useDeliveryStore
        .getState()
        .requestFocus(deliveryNodeId.run(selectedRunId));
    }
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

  const lastFittedPipeline = useRef<string | null>(null);
  const selectedPlanRevision = selectedRunId
    ? (plans[selectedRunId]?.revision ?? null)
    : null;
  useEffect(() => {
    if (
      !selectedRequirementId ||
      !selectedRunId ||
      selectedPlanRevision === null
    ) {
      return;
    }
    const pipelineKey = `${selectedRequirementId}:${selectedRunId}:${selectedPlanRevision}`;
    if (lastFittedPipeline.current === pipelineKey) return;
    const fitTypes = new Set<DeliveryFlowNode["type"]>([
      "run",
      "work_plan",
      "plan_invalid",
      "work_item",
      "diff",
      "validation",
      "review",
      "publication",
    ]);
    const pipelineNodes = nodes.filter((node) => fitTypes.has(node.type));
    if (pipelineNodes.length <= 1) return;
    let frame = 0;
    let attempts = 0;
    const fitWhenReady = () => {
      void rf
        .fitView({
          nodes: pipelineNodes,
          padding: 0.16,
          minZoom: 0.42,
          maxZoom: 0.9,
          duration: 280,
        })
        .then((fitted) => {
          if (fitted) {
            lastFittedPipeline.current = pipelineKey;
            return;
          }
          attempts += 1;
          if (attempts < 60) frame = requestAnimationFrame(fitWhenReady);
        });
    };
    frame = requestAnimationFrame(fitWhenReady);
    return () => cancelAnimationFrame(frame);
    // 流水线状态只更新节点内容；只有选择、Run 或 plan revision 改变时重新 fit。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf, selectedPlanRevision, selectedRequirementId, selectedRunId]);

  /* 一次性聚焦请求（深链 / GrayDango 定位） */
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
        { zoom: 0.9, duration: 320 },
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
        minZoom={0.3}
        maxZoom={1.4}
        proOptions={{ hideAttribution: true }}
        aria-label="需求交付子画布"
      />
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
