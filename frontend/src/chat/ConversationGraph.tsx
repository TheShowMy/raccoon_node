import {
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { PixelButton } from "@pxlkit/ui-kit";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Size } from "../canvas/geometry";
import {
  persistScrollPosition,
  restoreScrollPositions,
} from "../canvas/nodeScroll";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useCanvasStore, type Viewport } from "../store/canvasStore";
import { useDomainStore } from "../store/domainStore";
import type { WorkbenchAction } from "../api/types";
import {
  WorkbenchActionConfirmationNode,
  WorkbenchActionResultNode,
} from "../workbenches/shared/actionNodes";
import {
  CHAT_NODE_GAP,
  branchActiveNodes,
  deriveBranchInputGate,
  displayItemId,
  displayItemSize,
  followTargetItem,
  layoutBranchDisplay,
  projectBranchDisplay,
  visibleBranchItems,
  type BranchDisplayItem,
  type BranchDisplayItemSizes,
} from "./dag";
import {
  AssistantAnswerNode,
  ClarificationAnswerNode,
  ClarificationQuestionNode,
  ComposerNode,
  ProcessGroupNode,
  ProcessNode,
  RequirementConfirmationNode,
  RequirementSpecNode,
  ToolNode,
  UserMessageNode,
} from "./nodes";
import { composerScopeKey, useComposerStore } from "../store/composerStore";

const nodeTypes = {
  composer: ComposerNode,
  user_message: UserMessageNode,
  process: ProcessNode,
  tool: ToolNode,
  assistant_answer: AssistantAnswerNode,
  clarification_question: ClarificationQuestionNode,
  clarification_answer: ClarificationAnswerNode,
  requirement_spec: RequirementSpecNode,
  requirement_confirmation: RequirementConfirmationNode,
  process_group: ProcessGroupNode,
  action_confirmation: WorkbenchActionConfirmationNode,
  action_result: WorkbenchActionResultNode,
};

type ChatFlowNode = Node<Record<string, unknown>>;

const DEFAULT_VIEWPORT: Viewport = { x: 32, y: 32, zoom: 1 };

function buildFlowNodes(
  items: BranchDisplayItem[],
  sessionId: string,
  branchId: string,
  sizes: BranchDisplayItemSizes,
  selectedNodeId: string | null,
): ChatFlowNode[] {
  return items.map((item) => {
    if (item.type === "composer") {
      return {
        id: item.id,
        type: "composer",
        position: item.position,
        data: { sessionId, branchId },
        draggable: false,
        selectable: false,
        deletable: false,
        style: { width: displayItemSize(item, sizes).width },
      };
    }
    if (item.type === "process_group") {
      return {
        id: item.id,
        type: "process_group",
        position: item.position,
        data: item,
        draggable: false,
        selectable: false,
        deletable: false,
        style: { width: displayItemSize(item, sizes).width },
      };
    }
    return {
      id: item.node.id,
      type: item.node.kind,
      position: item.position,
      data: {
        node: item.node,
        sessionId,
        branchId,
        selected: item.node.id === selectedNodeId,
      },
      draggable: false,
      selectable: false,
      deletable: false,
      style: { width: displayItemSize(item, sizes).width },
    };
  });
}

function buildEdges(items: BranchDisplayItem[]): Edge[] {
  const edges: Edge[] = [];
  for (let index = 1; index < items.length; index += 1) {
    const source = displayItemId(items[index - 1]);
    const target = displayItemId(items[index]);
    edges.push({
      id: `e-${source}-${target}`,
      source,
      target,
      type: "step",
      selectable: false,
      focusable: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { stroke: "var(--px-muted)", strokeWidth: 2 },
    });
  }
  return edges;
}

const ACTION_NODE_WIDTH = 340;
const ACTION_NODE_ESTIMATED_HEIGHT = 220;

type ConversationActionProjection = {
  nodes: ChatFlowNode[];
  edges: Edge[];
};

/** redact 仍是图内关系：来源 → 两阶段确认 → 操作结果。 */
export function projectConversationActions(
  actions: WorkbenchAction[],
  items: BranchDisplayItem[],
  sizes: BranchDisplayItemSizes,
): ConversationActionProjection {
  const nodes: ChatFlowNode[] = [];
  const edges: Edge[] = [];
  const byId = new Map(items.map((item) => [displayItemId(item), item]));

  for (const action of actions) {
    if (
      (action.kind !== "conversation_redact" &&
        action.kind !== "conversation_new_session") ||
      !action.source_node_id
    ) {
      continue;
    }
    const source = byId.get(action.source_node_id);
    if (!source) continue;
    const sourceSize = displayItemSize(source, sizes);
    const confirmationId = `chat-action-confirm:${action.id}`;
    const confirmationSize = sizes[confirmationId] ?? {
      width: ACTION_NODE_WIDTH,
      height: ACTION_NODE_ESTIMATED_HEIGHT,
    };
    const confirmationPosition = {
      x: source.position.x + sourceSize.width + CHAT_NODE_GAP,
      y: source.position.y,
    };
    nodes.push({
      id: confirmationId,
      type: "action_confirmation",
      position: confirmationPosition,
      data: { action },
      draggable: false,
      selectable: false,
      deletable: false,
      style: { width: confirmationSize.width },
    });
    edges.push({
      id: `e-${action.source_node_id}-${confirmationId}`,
      source: action.source_node_id,
      sourceHandle: source.type === "composer" ? "out-r" : undefined,
      target: confirmationId,
      targetHandle: "in-l",
      type: "step",
      selectable: false,
      focusable: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    });

    if (action.state === "awaiting") continue;
    const resultId = `chat-action-result:${action.id}`;
    const resultSize = sizes[resultId] ?? {
      width: ACTION_NODE_WIDTH,
      height: 170,
    };
    nodes.push({
      id: resultId,
      type: "action_result",
      position: {
        x: confirmationPosition.x,
        y: confirmationPosition.y + confirmationSize.height + CHAT_NODE_GAP,
      },
      data: { action },
      draggable: false,
      selectable: false,
      deletable: false,
      style: { width: resultSize.width },
    });
    edges.push({
      id: `e-${confirmationId}-${resultId}`,
      source: confirmationId,
      sourceHandle: "out-b",
      target: resultId,
      targetHandle: "in-t",
      type: "step",
      selectable: false,
      focusable: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    });
  }
  return { nodes, edges };
}

const CHAT_CAMERA_SAFE_MARGIN = 24;

function safeAnchor(
  preferred: number,
  extent: number,
  renderedSize: number,
): number {
  const minimum = CHAT_CAMERA_SAFE_MARGIN + renderedSize / 2;
  const maximum = extent - CHAT_CAMERA_SAFE_MARGIN - renderedSize / 2;
  return minimum <= maximum
    ? Math.min(Math.max(preferred, minimum), maximum)
    : extent / 2;
}

/** 活跃节点锚在画布下方中部：保持 zoom，只平移。 */
export function anchoredConversationViewport(
  item: BranchDisplayItem,
  sizes: BranchDisplayItemSizes,
  host: Size,
  zoom: number,
): Viewport {
  const size = displayItemSize(item, sizes);
  return anchoredNodeViewport(item.position, size, host, zoom);
}

function anchoredNodeViewport(
  position: { x: number; y: number },
  size: Size,
  host: Size,
  zoom: number,
): Viewport {
  const centerX = position.x + size.width / 2;
  const centerY = position.y + size.height / 2;
  const anchorX = safeAnchor(host.width * 0.5, host.width, size.width * zoom);
  const anchorY = safeAnchor(
    host.height * 0.65,
    host.height,
    size.height * zoom,
  );
  return {
    zoom,
    x: anchorX - centerX * zoom,
    y: anchorY - centerY * zoom,
  };
}

export function anchoredRenderedNodeViewport(
  nodeRect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  hostRect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  current: Viewport,
): Viewport {
  const anchorX = safeAnchor(
    hostRect.width * 0.5,
    hostRect.width,
    nodeRect.width,
  );
  const anchorY = safeAnchor(
    hostRect.height * 0.65,
    hostRect.height,
    nodeRect.height,
  );
  const centerX = nodeRect.left + nodeRect.width / 2 - hostRect.left;
  const centerY = nodeRect.top + nodeRect.height / 2 - hostRect.top;
  return {
    zoom: current.zoom,
    x: current.x + anchorX - centerX,
    y: current.y + anchorY - centerY,
  };
}

export function followTransitionDuration(
  reducedMotion: boolean,
  sameTarget: boolean,
): number {
  return reducedMotion ? 0 : sameTarget ? 100 : 220;
}

export function shouldMoveConversationCamera(
  current: Viewport,
  next: Viewport,
): boolean {
  return (
    Math.abs(current.x - next.x) >= 1 ||
    Math.abs(current.y - next.y) >= 1 ||
    Math.abs(current.zoom - next.zoom) >= 0.001
  );
}

const CAMERA_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

function viewportTransform(viewport: Viewport): string {
  return `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
}

function readRenderedViewport(
  element: HTMLElement | null | undefined,
  fallback: Viewport,
): Viewport {
  if (!element) return fallback;
  const transform = new DOMMatrix(getComputedStyle(element).transform);
  return { x: transform.e, y: transform.f, zoom: transform.a };
}

const BRANCH_LABEL = (branchId: string, rootId: string) =>
  branchId === rootId ? "主分支" : `分支 ${branchId.replace(/^b-/, "#")}`;

const ConversationGraphInner = memo(function ConversationGraphInner() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<Size>({ width: 800, height: 560 });
  const [following, setFollowing] = useState(true);
  const [sizes, setSizes] = useState<BranchDisplayItemSizes>({});
  const lastFollowTargetRef = useRef<string | null>(null);
  const followFrameRef = useRef<number | null>(null);
  const cameraRequestRef = useRef(0);
  const cameraAnimationRef = useRef<Animation | null>(null);
  const programmaticMoveRef = useRef(0);
  const pendingSizesRef = useRef<BranchDisplayItemSizes>({});
  const sizeFrameRef = useRef<number | null>(null);
  const flow = useReactFlow<ChatFlowNode>();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const navigate = useNavigate();
  const params = useParams<{ branchId?: string; nodeId?: string }>();

  const conversation = useDomainStore((state) => state.conversation);
  const sessionId = useDomainStore(
    (state) => state.activeConversationSessionId,
  );
  const requirements = useDomainStore((state) => state.requirements);
  const clarifications = useDomainStore((state) => state.clarifications);
  const recentConversationNodeId = useDomainStore(
    (state) => state.recentConversationNodeId,
  );
  const workbenchActions = useDomainStore((state) => state.workbenchActions);
  const connection = useDomainStore((state) => state.connection);
  const rootBranchId = conversation.root_branch_id;
  const requestedBranchId = useCanvasStore(
    (state) => state.activeConversationBranchId,
  );
  const branchId =
    requestedBranchId && conversation.branches[requestedBranchId]
      ? requestedBranchId
      : rootBranchId;
  const conversationScope = composerScopeKey(sessionId, branchId);
  const expandedIds = useCanvasStore((state) => state.expandedProcessGroupIds);
  const followRequestId = useCanvasStore(
    (state) => state.conversationFollowRequestId,
  );
  const viewport = useCanvasStore(
    (state) =>
      state.conversationViewports[conversationScope] ?? DEFAULT_VIEWPORT,
  );

  const inputGate = useMemo(
    () =>
      deriveBranchInputGate(
        conversation,
        branchId,
        Object.values(requirements),
        Object.values(clarifications),
      ),
    [conversation, branchId, requirements, clarifications],
  );
  const projectedItems = useMemo(
    () => projectBranchDisplay(conversation, branchId, expandedIds, inputGate),
    [conversation, branchId, expandedIds, inputGate],
  );
  const items = useMemo(
    () => layoutBranchDisplay(projectedItems, sizes),
    [projectedItems, sizes],
  );
  const selectedNodeId = useCanvasStore(
    (state) => state.selectedConversationNodeId,
  );

  const followTarget = useMemo(
    () =>
      following
        ? followTargetItem(items, inputGate, recentConversationNodeId)
        : null,
    [following, items, inputGate, recentConversationNodeId],
  );
  const renderedItemsRef = useRef<BranchDisplayItem[]>([]);
  const renderedItems = useMemo(() => {
    // 普通对话保持稳定挂载，避免相机过渡期间反复挂载节点触发测量环；
    // 只有大历史才启用我们自己的窗口化，React Flow 不再叠加第二层裁剪。
    const next =
      items.length <= 500
        ? items
        : visibleBranchItems(
            items,
            sizes,
            viewport,
            host,
            [
              selectedNodeId,
              followTarget ? displayItemId(followTarget) : null,
            ].filter((id): id is string => Boolean(id)),
          );
    const previous = renderedItemsRef.current;
    if (
      next.length === previous.length &&
      next.every((item, index) => item === previous[index])
    ) {
      return previous;
    }
    renderedItemsRef.current = next;
    return next;
  }, [items, sizes, viewport, host, selectedNodeId, followTarget]);

  const actionProjection = useMemo(
    () =>
      projectConversationActions(
        Object.values(workbenchActions),
        renderedItems,
        sizes,
      ),
    [renderedItems, sizes, workbenchActions],
  );

  const nodes = useMemo(
    () => [
      ...buildFlowNodes(
        renderedItems,
        sessionId,
        branchId,
        sizes,
        selectedNodeId,
      ),
      ...actionProjection.nodes,
    ],
    [
      renderedItems,
      sessionId,
      branchId,
      sizes,
      selectedNodeId,
      actionProjection.nodes,
    ],
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (wrapperRef.current) {
        restoreScrollPositions(
          wrapperRef.current,
          `conversation:${conversationScope}`,
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationScope, nodes]);
  const onNodesChange = useCallback(
    (changes: NodeChange<ChatFlowNode>[]) => {
      const dimensions = changes.filter(
        (change) => change.type === "dimensions" && change.dimensions,
      );
      if (dimensions.length > 0) {
        for (const change of dimensions) {
          if (change.type !== "dimensions" || !change.dimensions) continue;
          pendingSizesRef.current = {
            ...pendingSizesRef.current,
            [change.id]: {
              width: Math.round(change.dimensions.width),
              height: Math.round(change.dimensions.height),
            },
          };
        }
        if (sizeFrameRef.current === null) {
          sizeFrameRef.current = requestAnimationFrame(() => {
            const pending = pendingSizesRef.current;
            pendingSizesRef.current = {};
            sizeFrameRef.current = null;
            setSizes((current) => {
              let changed = false;
              const next = { ...current };
              for (const [id, pendingSize] of Object.entries(pending)) {
                const internalSize = flow.getInternalNode(id)?.measured;
                const measured = {
                  width: Math.round(internalSize?.width ?? pendingSize.width),
                  height: Math.round(
                    internalSize?.height ?? pendingSize.height,
                  ),
                };
                const previous = current[id];
                if (
                  !previous ||
                  previous.width !== measured.width ||
                  previous.height !== measured.height
                ) {
                  next[id] = measured;
                  changed = true;
                }
              }
              return changed ? next : current;
            });
          });
        }
      }
    },
    [flow],
  );
  useEffect(
    () => () => {
      if (sizeFrameRef.current !== null) {
        cancelAnimationFrame(sizeFrameRef.current);
      }
    },
    [],
  );
  const renderedItemIds = useMemo(
    () => new Set(renderedItems.map(displayItemId)),
    [renderedItems],
  );
  const edges = useMemo(
    () => [
      ...buildEdges(items).filter(
        (edge) =>
          renderedItemIds.has(edge.source) && renderedItemIds.has(edge.target),
      ),
      ...actionProjection.edges,
    ],
    [items, renderedItemIds, actionProjection.edges],
  );

  // 宿主尺寸
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && frame === null) {
        const next = {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        frame = requestAnimationFrame(() => {
          frame = null;
          setHost((current) =>
            current.width !== next.width || current.height !== next.height
              ? next
              : current,
          );
        });
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  // 切换分支：恢复自动跟随，由跟随效应定位到该分支末端
  useEffect(() => {
    setFollowing(true);
  }, [branchId]);

  useEffect(() => {
    useCanvasStore
      .getState()
      .activateConversationSession(sessionId, rootBranchId);
    setSizes({});
    setFollowing(true);
    lastFollowTargetRef.current = null;
  }, [sessionId, rootBranchId]);

  // 发送、澄清、规格与确认等前向操作明确恢复跟随。
  useEffect(() => {
    if (followRequestId > 0) setFollowing(true);
  }, [followRequestId]);

  const moveCamera = useCallback(
    (next: Viewport, duration: number, requestId: number) => {
      if (requestId !== cameraRequestRef.current) return;
      const viewportElement = wrapperRef.current?.querySelector<HTMLElement>(
        ".react-flow__viewport",
      );
      const current = readRenderedViewport(viewportElement, flow.getViewport());
      if (!shouldMoveConversationCamera(current, next)) return;
      cameraAnimationRef.current?.cancel();
      cameraAnimationRef.current = null;
      programmaticMoveRef.current = 1;
      if (duration === 0 || !viewportElement?.animate) {
        void flow.setViewport(next);
        requestAnimationFrame(() => {
          if (requestId === cameraRequestRef.current)
            programmaticMoveRef.current = 0;
        });
        return;
      }
      const animation = viewportElement.animate(
        [
          { transform: viewportTransform(current) },
          { transform: viewportTransform(next) },
        ],
        { duration, easing: CAMERA_EASING, fill: "forwards" },
      );
      cameraAnimationRef.current = animation;
      void animation.finished
        .then(async () => {
          if (requestId !== cameraRequestRef.current) return;
          if (cameraAnimationRef.current === animation) {
            animation.commitStyles?.();
            animation.cancel();
            cameraAnimationRef.current = null;
          }
          await flow.setViewport(next);
          requestAnimationFrame(() => {
            if (requestId === cameraRequestRef.current)
              programmaticMoveRef.current = 0;
          });
        })
        .catch(() => undefined);
    },
    [flow],
  );

  const interruptCamera = useCallback(() => {
    cameraRequestRef.current += 1;
    const viewportElement = wrapperRef.current?.querySelector<HTMLElement>(
      ".react-flow__viewport",
    );
    if (cameraAnimationRef.current && viewportElement) {
      const current = readRenderedViewport(viewportElement, flow.getViewport());
      cameraAnimationRef.current.commitStyles?.();
      cameraAnimationRef.current.cancel();
      cameraAnimationRef.current = null;
      void flow.setViewport(current);
    }
    programmaticMoveRef.current = 0;
  }, [flow]);

  useEffect(
    () => () => {
      cameraAnimationRef.current?.cancel();
    },
    [],
  );

  // URL 深链是画布选择状态：切换分支、展开目标过程组并暂停自动跟随。
  useEffect(() => {
    if (!params.branchId || !params.nodeId) return;
    if (!conversation.branches[params.branchId]) return;
    if (params.branchId !== branchId) {
      useCanvasStore.getState().setActiveConversationBranch(params.branchId);
      return;
    }
    const group = projectedItems.find(
      (item) =>
        item.type === "process_group" &&
        item.members.some((member) => member.id === params.nodeId),
    );
    if (group?.type === "process_group" && !group.expanded) {
      useCanvasStore.getState().toggleProcessGroup(group.id);
      return;
    }
    useCanvasStore.getState().setSelectedConversationNode(params.nodeId);
    setFollowing(false);
  }, [
    branchId,
    conversation.branches,
    params.branchId,
    params.nodeId,
    projectedItems,
  ]);

  // 自动跟随最新（FE-CHAT-012：流式增量不抢焦点，用户上翻后暂停）；
  // 进行中聚焦活动节点，空闲聚焦分支末端
  useEffect(() => {
    if (!following) return;
    const target = followTarget;
    if (!target) return;
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
    }
    const requestId = ++cameraRequestRef.current;
    let measurementAttempts = 0;
    const focus = () => {
      if (requestId !== cameraRequestRef.current) return;
      const targetId = displayItemId(target);
      const internalSize = flow.getInternalNode(targetId)?.measured;
      if (!internalSize && measurementAttempts < 2) {
        measurementAttempts += 1;
        followFrameRef.current = requestAnimationFrame(focus);
        return;
      }
      const focusSizes = internalSize
        ? {
            ...sizes,
            [targetId]: {
              width: Math.round(internalSize.width ?? 0),
              height: Math.round(internalSize.height ?? 0),
            },
          }
        : sizes;
      const viewportElement = wrapperRef.current?.querySelector<HTMLElement>(
        ".react-flow__viewport",
      );
      const currentViewport = readRenderedViewport(
        viewportElement,
        flow.getViewport(),
      );
      const targetElement = [
        ...(wrapperRef.current?.querySelectorAll<HTMLElement>(
          ".react-flow__node[data-id]",
        ) ?? []),
      ].find((element) => element.dataset.id === targetId);
      const renderedViewport =
        targetElement && wrapperRef.current
          ? anchoredRenderedNodeViewport(
              targetElement.getBoundingClientRect(),
              wrapperRef.current.getBoundingClientRect(),
              currentViewport,
            )
          : null;
      const duration = followTransitionDuration(
        reducedMotion,
        lastFollowTargetRef.current === targetId,
      );
      lastFollowTargetRef.current = targetId;
      void moveCamera(
        renderedViewport ??
          anchoredConversationViewport(
            target,
            focusSizes,
            host,
            currentViewport.zoom,
          ),
        duration,
        requestId,
      );
      followFrameRef.current = null;
    };
    followFrameRef.current = requestAnimationFrame(focus);
    return () => {
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
    };
    // 仅在跟随状态下对齐目标；用户 zoom 变化不主动重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    followTarget,
    following,
    branchId,
    host,
    reducedMotion,
    moveCamera,
    sizes,
  ]);

  // 显式选择（深链、GrayDango 或节点点击）聚焦历史节点，但不恢复自动跟随。
  useEffect(() => {
    if (!selectedNodeId || following) return;
    const target = items.find((item) => displayItemId(item) === selectedNodeId);
    if (!target) return;
    void moveCamera(
      anchoredConversationViewport(
        target,
        sizes,
        host,
        flow.getViewport().zoom,
      ),
      reducedMotion ? 0 : 180,
      ++cameraRequestRef.current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedNodeId,
    following,
    items,
    sizes,
    host,
    reducedMotion,
    moveCamera,
  ]);

  const branches = useMemo(
    () => Object.values(conversation.branches),
    [conversation.branches],
  );
  const pendingNewSessionAction = useMemo(
    () =>
      Object.values(workbenchActions).find(
        (action) =>
          action.kind === "conversation_new_session" &&
          action.payload.session_id === sessionId &&
          action.state === "awaiting",
      ) ?? null,
    [sessionId, workbenchActions],
  );
  const [creatingSession, setCreatingSession] = useState(false);
  const creatingSessionRef = useRef(false);
  const sessionPromptReturnRef = useRef<{
    sessionId: string;
    viewport: Viewport;
  } | null>(null);

  useEffect(() => {
    if (!pendingNewSessionAction) {
      const previous = sessionPromptReturnRef.current;
      if (previous && previous.sessionId === sessionId) {
        sessionPromptReturnRef.current = null;
        void moveCamera(
          previous.viewport,
          reducedMotion ? 0 : 180,
          ++cameraRequestRef.current,
        );
      }
      return;
    }
    if (sessionPromptReturnRef.current) return;
    sessionPromptReturnRef.current = {
      sessionId,
      viewport: flow.getViewport(),
    };
    setFollowing(false);
    const frame = requestAnimationFrame(() => {
      const nodeId = `chat-action-confirm:${pendingNewSessionAction.id}`;
      const node = flow.getNode(nodeId);
      if (!node) return;
      const measured = flow.getInternalNode(nodeId)?.measured;
      const size = {
        width: measured?.width ?? ACTION_NODE_WIDTH,
        height: measured?.height ?? ACTION_NODE_ESTIMATED_HEIGHT,
      };
      void moveCamera(
        anchoredNodeViewport(
          node.position,
          size,
          host,
          flow.getViewport().zoom,
        ),
        reducedMotion ? 0 : 220,
        ++cameraRequestRef.current,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [
    flow,
    host,
    moveCamera,
    pendingNewSessionAction,
    reducedMotion,
    sessionId,
  ]);

  useEffect(() => {
    if (sessionPromptReturnRef.current?.sessionId !== sessionId) {
      sessionPromptReturnRef.current = null;
    }
  }, [sessionId]);

  const createSession = useCallback(async () => {
    if (
      creatingSessionRef.current ||
      creatingSession ||
      pendingNewSessionAction
    )
      return;
    const draft = useComposerStore.getState().drafts[conversationScope];
    const hasDraft = Boolean(
      draft?.text.trim() || draft?.file_refs.length || draft?.images.length,
    );
    const active = branchActiveNodes(conversation, branchId);
    const source =
      followTarget ?? items[items.length - 1] ?? projectedItems.at(-1) ?? null;
    const sourceId = source ? displayItemId(source) : `composer:${branchId}`;
    if (hasDraft || active.length > 0 || inputGate) {
      creatingSessionRef.current = true;
      setCreatingSession(true);
      try {
        await useDomainStore.getState().requestWorkbenchAction({
          kind: "conversation_new_session",
          source_node_id: sourceId,
          payload: { session_id: sessionId, branch_id: branchId },
        });
      } finally {
        creatingSessionRef.current = false;
        setCreatingSession(false);
      }
      return;
    }
    creatingSessionRef.current = true;
    setCreatingSession(true);
    try {
      await useDomainStore
        .getState()
        .createConversationSession(crypto.randomUUID());
    } finally {
      creatingSessionRef.current = false;
      setCreatingSession(false);
    }
  }, [
    branchId,
    conversation,
    conversationScope,
    creatingSession,
    followTarget,
    inputGate,
    items,
    pendingNewSessionAction,
    projectedItems,
    sessionId,
  ]);

  return (
    <div
      ref={wrapperRef}
      className="conversation-graph"
      data-compact={viewport.zoom < 0.6 || undefined}
      onScrollCapture={(event) =>
        persistScrollPosition(event.target, `conversation:${conversationScope}`)
      }
      onPointerDownCapture={(event) => {
        if (
          (event.target as Element | null)?.classList.contains(
            "react-flow__pane",
          )
        ) {
          setFollowing(false);
          interruptCamera();
        }
      }}
      onWheelCapture={(event) => {
        // 只把空白画布上的滚轮视为相机操作；节点内部滚动仍保持跟随。
        if (
          (event.target as Element | null)?.classList.contains(
            "react-flow__pane",
          )
        ) {
          setFollowing(false);
          interruptCamera();
        }
      }}
    >
      <ReactFlow
        key={sessionId}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        viewport={viewport}
        onViewportChange={(next) =>
          useCanvasStore
            .getState()
            .setConversationViewport(conversationScope, next)
        }
        onMoveStart={(_event) => {
          // 只有真实指针/滚轮操作暂停；程序相机事务不能误伤自动跟随。
          if (_event?.isTrusted && programmaticMoveRef.current === 0) {
            setFollowing(false);
            interruptCamera();
          }
        }}
        onNodeClick={(_event, node) => {
          if (
            (_event.target as Element | null)?.closest(
              "button,input,textarea,select,a",
            )
          ) {
            return;
          }
          if (node.type !== "composer") {
            useCanvasStore.getState().setSelectedConversationNode(node.id);
            setFollowing(false);
            navigate(`/canvas/chat/branches/${branchId}/nodes/${node.id}`);
          }
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.35}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        aria-label="中央对话节点图"
      />
      <div className="chat-toolbar nodrag nowheel">
        {branches.map((branch) => (
          <button
            key={branch.id}
            type="button"
            className="chat-toolbar__branch"
            data-active={branch.id === branchId || undefined}
            onClick={() =>
              useCanvasStore.getState().setActiveConversationBranch(branch.id)
            }
          >
            {BRANCH_LABEL(branch.id, rootBranchId)}
          </button>
        ))}
        {connection !== "open" ? (
          <span className="chat-toolbar__connection" role="status">
            事件流{connection === "retrying" ? "重连中" : "连接中"}…
          </span>
        ) : null}
      </div>
      <PixelButton
        className="chat-new-session nodrag nowheel"
        size="sm"
        variant="outline"
        disabled={creatingSession || Boolean(pendingNewSessionAction)}
        onClick={() => void createSession()}
      >
        ＋ 新建会话
      </PixelButton>
      {!following ? (
        <button
          type="button"
          className="chat-follow nodrag nowheel"
          onClick={() => setFollowing(true)}
        >
          ↓ 回到最新
        </button>
      ) : null}
    </div>
  );
});

/** 中央对话节点图：独立受控 viewport 的嵌套 React Flow（02 §5） */
export const ConversationGraph = memo(function ConversationGraph() {
  return (
    <ReactFlowProvider>
      <ConversationGraphInner />
    </ReactFlowProvider>
  );
});
