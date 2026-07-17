import {
  applyNodeChanges,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Size } from "../canvas/geometry";
import { useCanvasStore, type Viewport } from "../store/canvasStore";
import { useDomainStore } from "../store/domainStore";
import {
  branchEndPosition,
  CHAT_NODE_WIDTH,
  followTargetPosition,
  projectBranchDisplay,
  type BranchDisplayItem,
} from "./dag";
import {
  AssistantAnswerNode,
  ComposerNode,
  ProcessGroupNode,
  ProcessNode,
  ToolNode,
  UserMessageNode,
} from "./nodes";

const nodeTypes = {
  composer: ComposerNode,
  user_message: UserMessageNode,
  process: ProcessNode,
  tool: ToolNode,
  assistant_answer: AssistantAnswerNode,
  process_group: ProcessGroupNode,
};

type ChatFlowNode = Node<Record<string, unknown>>;

const DEFAULT_VIEWPORT: Viewport = { x: 32, y: 32, zoom: 1 };

function displayItemId(item: BranchDisplayItem): string {
  switch (item.type) {
    case "node":
      return item.node.id;
    case "process_group":
      return item.id;
    case "composer":
      return item.id;
  }
}

function buildFlowNodes(
  items: BranchDisplayItem[],
  branchId: string,
): ChatFlowNode[] {
  return items.map((item) => {
    if (item.type === "composer") {
      return {
        id: item.id,
        type: "composer",
        position: item.position,
        data: { branchId },
        draggable: false,
        selectable: false,
        deletable: false,
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
      };
    }
    return {
      id: item.node.id,
      type: item.node.kind,
      position: item.position,
      data: { node: item.node, branchId },
      draggable: false,
      selectable: false,
      deletable: false,
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

/** 跟随分支末端：保持当前 zoom，仅平移（FE-CHAT-012 自动跟随） */
function endViewport(
  end: { x: number; y: number },
  host: Size,
  zoom: number,
): Viewport {
  return {
    zoom,
    x: host.width / 2 - (end.x + CHAT_NODE_WIDTH / 2) * zoom,
    y: host.height * 0.62 - (end.y + 80) * zoom,
  };
}

const BRANCH_LABEL = (branchId: string, rootId: string) =>
  branchId === rootId ? "主分支" : `分支 ${branchId.replace(/^b-/, "#")}`;

const ConversationGraphInner = memo(function ConversationGraphInner() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<Size>({ width: 800, height: 560 });
  const [following, setFollowing] = useState(true);

  const conversation = useDomainStore((state) => state.conversation);
  const connection = useDomainStore((state) => state.connection);
  const rootBranchId = conversation.root_branch_id;
  const branchId = useCanvasStore(
    (state) => state.activeConversationBranchId ?? rootBranchId,
  );
  const expandedIds = useCanvasStore((state) => state.expandedProcessGroupIds);
  const viewport = useCanvasStore(
    (state) => state.conversationViewports[branchId] ?? DEFAULT_VIEWPORT,
  );

  const items = useMemo(
    () => projectBranchDisplay(conversation, branchId, expandedIds),
    [conversation, branchId, expandedIds],
  );

  const [nodes, setNodes] = useState<ChatFlowNode[]>([]);
  useEffect(() => {
    setNodes(buildFlowNodes(items, branchId));
  }, [items, branchId]);
  const onNodesChange = useCallback(
    (changes: NodeChange<ChatFlowNode>[]) =>
      setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const edges = useMemo(() => buildEdges(items), [items]);

  // 宿主尺寸
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setHost({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 切换分支：恢复自动跟随，由跟随效应定位到该分支末端
  useEffect(() => {
    setFollowing(true);
  }, [branchId]);

  // 自动跟随最新（FE-CHAT-012：流式增量不抢焦点，用户上翻后暂停）；
  // 进行中聚焦活动节点，空闲聚焦分支末端
  useEffect(() => {
    if (!following) return;
    const target = followTargetPosition(items) ?? branchEndPosition(items);
    if (!target) return;
    useCanvasStore
      .getState()
      .setConversationViewport(
        branchId,
        endViewport(target, host, viewport.zoom),
      );
    // 仅在跟随状态下对齐目标；zoom 变化不需要重定位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, following, branchId, host]);

  const branches = useMemo(
    () => Object.values(conversation.branches),
    [conversation.branches],
  );

  return (
    <div
      ref={wrapperRef}
      className="conversation-graph nodrag nowheel"
      data-compact={viewport.zoom < 0.6 || undefined}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        viewport={viewport}
        onViewportChange={(next) =>
          useCanvasStore.getState().setConversationViewport(branchId, next)
        }
        onMoveStart={(_event) => {
          // 用户手动平移/缩放（程序写入不触发）→ 暂停自动跟随
          if (_event) setFollowing(false);
        }}
        onNodeClick={(_event, node) => {
          if (node.type !== "composer") {
            useCanvasStore.getState().setSelectedConversationNode(node.id);
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
