import {
  applyNodeChanges,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeChange,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useMatch } from "react-router-dom";
import { useCanvasStore, type Viewport } from "../../store/canvasStore";
import { useDeliveryStore } from "../../store/deliveryStore";
import { useDomainStore } from "../../store/domainStore";
import { DevScenarioBar } from "./DevScenarioBar";
import {
  ActionConfirmationNode,
  ActionResultNode,
  ClarificationNode,
  ConfirmationNode,
  DiffNode,
  DiagnosticsNode,
  PublicationNode,
  RequirementListNode,
  ReviewNode,
  RunNode,
  SourceRefNode,
  SpecNode,
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
  source_ref: SourceRefNode,
  clarification: ClarificationNode,
  spec: SpecNode,
  confirmation: ConfirmationNode,
  run: RunNode,
  work_plan: WorkPlanNode,
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
  const clarifications = useDomainStore((state) => state.clarifications);
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
      store.selectRequirement(deepRequirementId);
      // 聚焦需求当前最关键的一跳节点
      const target =
        requirement.state === "spec_ready"
          ? deliveryNodeId.confirmation(deepRequirementId)
          : requirement.latest_revision > 0
            ? deliveryNodeId.spec(deepRequirementId)
            : requirement.latest_run_id
              ? deliveryNodeId.run(requirement.latest_run_id)
              : deliveryNodeId.list();
      store.requestFocus(target);
    }
  }, [deepRequirementId, deepRunId]);

  /* 未选中时默认选中第一个需求（FE-DELIVERY-003 从列表锚点开始） */
  useEffect(() => {
    const selected = useDeliveryStore.getState().selectedRequirementId;
    const all = Object.values(requirements);
    if (selected && requirements[selected]) return;
    const first = [...all].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    )[0];
    if (first) useDeliveryStore.getState().selectRequirement(first.id);
  }, [requirements]);

  /* 状态跃迁自动聚焦：规格就绪 → 确认节点；Run 启动 → RunNode（演示流程不丢焦点） */
  const selectedRequirement = selectedRequirementId
    ? requirements[selectedRequirementId]
    : undefined;
  const selectedRunId = selectedRequirement?.latest_run_id ?? null;
  const selectedState = selectedRequirement?.state ?? null;
  useEffect(() => {
    if (!selectedRequirementId) return;
    if (selectedRunId) {
      useDeliveryStore
        .getState()
        .requestFocus(deliveryNodeId.run(selectedRunId));
      return;
    }
    if (selectedState === "spec_ready") {
      useDeliveryStore
        .getState()
        .requestFocus(deliveryNodeId.confirmation(selectedRequirementId));
    }
  }, [selectedRequirementId, selectedState, selectedRunId]);

  const projection = useMemo(
    () =>
      projectDelivery({
        requirements,
        clarifications,
        revisions,
        runs,
        plans,
        validations,
        reviews,
        publications,
        actions,
        selectedRequirementId,
      }),
    [
      requirements,
      clarifications,
      revisions,
      runs,
      plans,
      validations,
      reviews,
      publications,
      actions,
      selectedRequirementId,
    ],
  );

  const [nodes, setNodes] = useState<DeliveryFlowNode[]>([]);
  useEffect(() => {
    setNodes(projection.nodes);
  }, [projection]);
  const onNodesChange = useCallback(
    (changes: NodeChange<DeliveryFlowNode>[]) =>
      setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );

  /* 一次性聚焦请求（深链 / GrayDango 定位） */
  useEffect(() => {
    if (!focusRequest) return;
    const target = nodes.find((node) => node.id === focusRequest.nodeId);
    if (target) {
      const width =
        typeof target.style?.width === "number" ? target.style.width : 200;
      void rf.setCenter(
        target.position.x + width / 2,
        target.position.y + 120,
        { zoom: 0.9, duration: 320 },
      );
    }
    useDeliveryStore.getState().clearFocus();
  }, [focusRequest, nodes, rf]);

  const viewport = useCanvasStore(
    (state) => state.workbenchViewports.delivery ?? DEFAULT_VIEWPORT,
  );

  return (
    <div className="delivery-canvas nodrag nowheel">
      <ReactFlow
        nodes={nodes}
        edges={projection.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        viewport={viewport}
        onViewportChange={(next) =>
          useCanvasStore.getState().saveWorkbenchViewport("delivery", next)
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
      <DevScenarioBar />
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
