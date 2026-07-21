import { PixelButton } from "@pxlkit/ui-kit";
import { useMutation } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import {
  persistScrollPosition,
  restoreScrollPositions,
} from "../canvas/nodeScroll";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { getApi } from "../api";
import { useCanvasStore } from "../store/canvasStore";
import { selectActiveConversation, useDomainStore } from "../store/domainStore";
import type { ConversationBranch, WorkbenchAction } from "../api/types";
import {
  ActionConfirmationCard,
  ActionResultCard,
} from "../workbenches/shared/actionNodes";
import {
  branchActiveNodes,
  deriveBranchInputGate,
  displayItemId,
  estimatedDisplayItemHeight,
  followTargetItem,
  projectBranchDisplay,
  type BranchDisplayItem,
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
  type ConversationNodeData,
} from "./nodes";
import { composerScopeKey, useComposerStore } from "../store/composerStore";

/* ── 列表行模型：领域条目 + 危险操作确认/结果行 ── */

type ChatRow =
  | { kind: "item"; id: string; item: BranchDisplayItem }
  | {
      kind: "action_confirmation" | "action_result";
      id: string;
      action: WorkbenchAction;
    };

const ACTION_CONFIRM_ID = (actionId: string) =>
  `chat-action-confirm:${actionId}`;
const ACTION_RESULT_ID = (actionId: string) => `chat-action-result:${actionId}`;

/** 危险操作链（来源 → 确认 → 结果）作为列表行紧跟来源条目（FE-CANVAS-019）。 */
export function buildRows(
  items: BranchDisplayItem[],
  actions: WorkbenchAction[],
): ChatRow[] {
  const bySource = new Map<string, WorkbenchAction[]>();
  for (const action of actions) {
    if (
      (action.kind !== "conversation_redact" &&
        action.kind !== "conversation_new_session") ||
      !action.source_node_id
    ) {
      continue;
    }
    const list = bySource.get(action.source_node_id) ?? [];
    list.push(action);
    bySource.set(action.source_node_id, list);
  }
  const rows: ChatRow[] = [];
  for (const item of items) {
    rows.push({ kind: "item", id: displayItemId(item), item });
    for (const action of bySource.get(displayItemId(item)) ?? []) {
      rows.push({
        kind: "action_confirmation",
        id: ACTION_CONFIRM_ID(action.id),
        action,
      });
      if (action.state !== "awaiting") {
        rows.push({
          kind: "action_result",
          id: ACTION_RESULT_ID(action.id),
          action,
        });
      }
    }
  }
  return rows;
}

const ROW_GAP = 12;
/* 列表内边距计入偏移量（滚动坐标 = padding + 前缀和），否则跟随永远短一截 */
const LIST_TOP_PAD = 48;
const LIST_BOTTOM_PAD = 16;
const ACTION_CONFIRM_ESTIMATE = 220;
const ACTION_RESULT_ESTIMATE = 170;
const WINDOW_THRESHOLD = 200;
const OVERSCAN_PX = 600;
const FOLLOW_BOTTOM_MARGIN = 24;
const PAUSE_DISTANCE_PX = 48;

function estimateRowHeight(row: ChatRow): number {
  if (row.kind === "item") return estimatedDisplayItemHeight(row.item);
  return row.kind === "action_confirmation"
    ? ACTION_CONFIRM_ESTIMATE
    : ACTION_RESULT_ESTIMATE;
}

/* ── 分支页签：显示来源摘要，分支逻辑一目了然 ── */

function branchLabel(
  branch: ConversationBranch,
  rootBranchId: string,
  nodes: Record<string, { content: string }>,
): { text: string; title: string } {
  if (branch.id === rootBranchId) {
    return { text: "主分支", title: "主分支" };
  }
  const anchor = branch.anchor_node_id
    ? nodes[branch.anchor_node_id]
    : undefined;
  const excerpt = anchor?.content.replace(/\s+/g, " ").trim() ?? "";
  if (!excerpt) {
    return { text: `分支 ${branch.id.replace(/^b-/, "#")}`, title: "平行分支" };
  }
  return {
    text: `分支·${excerpt.slice(0, 12)}${excerpt.length > 12 ? "…" : ""}`,
    title: `从「${excerpt.slice(0, 40)}」分出的平行对话；原分支保持不变`,
  };
}

/* ── 行渲染 ── */

function RowContent({
  row,
  sessionId,
  branchId,
  selectedNodeId,
}: {
  row: ChatRow;
  sessionId: string;
  branchId: string;
  selectedNodeId: string | null;
}) {
  if (row.kind !== "item") {
    return row.kind === "action_confirmation" ? (
      <ActionConfirmationCard action={row.action} />
    ) : (
      <ActionResultCard action={row.action} />
    );
  }
  const item = row.item;
  if (item.type === "composer") {
    return <ComposerNode sessionId={sessionId} branchId={branchId} />;
  }
  if (item.type === "process_group") {
    return <ProcessGroupNode item={item} />;
  }
  const props: ConversationNodeData = {
    node: item.node,
    sessionId,
    branchId,
    selected: item.node.id === selectedNodeId,
  };
  switch (item.node.kind) {
    case "user_message":
      return <UserMessageNode {...props} />;
    case "process":
      return <ProcessNode {...props} />;
    case "tool":
      return <ToolNode {...props} />;
    case "assistant_answer":
      return <AssistantAnswerNode {...props} />;
    case "clarification_question":
      return <ClarificationQuestionNode {...props} />;
    case "clarification_answer":
      return <ClarificationAnswerNode {...props} />;
    case "requirement_spec":
      return <RequirementSpecNode {...props} />;
    case "requirement_confirmation":
      return <RequirementConfirmationNode {...props} />;
  }
}

const ConversationGraphInner = memo(function ConversationGraphInner() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState({ width: 800, height: 560 });
  const [following, setFollowing] = useState(true);
  const [heights, setHeights] = useState<Readonly<Record<string, number>>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const heightsRef = useRef<Record<string, number>>({});
  const heightFlushRef = useRef<number | null>(null);
  const rowObserversRef = useRef(new Map<string, ResizeObserver>());
  // 已处理的选择：点击产生的选择只标记不滚动；深链/GrayDango 选择才定位
  const handledSelectionRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const programmaticUntilRef = useRef(0);
  const followScrollTopRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const sessionPromptReturnRef = useRef<{
    sessionId: string;
    scrollTop: number;
  } | null>(null);
  const restoredScopeRef = useRef<string | null>(null);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const navigate = useNavigate();
  const params: { branchId?: string; nodeId?: string } =
    useMatch("/canvas/chat/branches/:branchId/nodes/:nodeId")?.params ?? {};

  const conversation = useDomainStore(selectActiveConversation);
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
  const selectedNodeId = useCanvasStore(
    (state) => state.selectedConversationNodeId,
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
  const rows = useMemo(
    () => buildRows(projectedItems, Object.values(workbenchActions)),
    [projectedItems, workbenchActions],
  );
  const followTarget = useMemo(
    () =>
      following
        ? followTargetItem(projectedItems, inputGate, recentConversationNodeId)
        : null,
    [following, projectedItems, inputGate, recentConversationNodeId],
  );
  const followTargetId = followTarget ? displayItemId(followTarget) : null;

  /* 行高：ResizeObserver 实测 + 首估（窗口化用） */
  const setRowRef = useCallback(
    (id: string) => (element: HTMLElement | null) => {
      const observers = rowObserversRef.current;
      observers.get(id)?.disconnect();
      observers.delete(id);
      if (!element) return;
      const observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (!rect) return;
        const height = Math.round(rect.height);
        if (heightsRef.current[id] === height) return;
        heightsRef.current[id] = height;
        if (heightFlushRef.current === null) {
          heightFlushRef.current = requestAnimationFrame(() => {
            heightFlushRef.current = null;
            setHeights({ ...heightsRef.current });
          });
        }
      });
      observer.observe(element);
      observers.set(id, observer);
    },
    [],
  );
  useEffect(
    () => () => {
      for (const observer of rowObserversRef.current.values()) {
        observer.disconnect();
      }
      rowObserversRef.current.clear();
      if (heightFlushRef.current !== null) {
        cancelAnimationFrame(heightFlushRef.current);
      }
    },
    [],
  );

  const rowHeight = useCallback(
    (row: ChatRow) => heights[row.id] ?? estimateRowHeight(row),
    [heights],
  );

  /* 前缀和布局（一维） */
  const layout = useMemo(() => {
    const offsets: number[] = new Array(rows.length);
    let acc = LIST_TOP_PAD;
    rows.forEach((row, index) => {
      offsets[index] = acc;
      acc += rowHeight(row) + ROW_GAP;
    });
    return { offsets, total: acc + LIST_BOTTOM_PAD };
  }, [rows, rowHeight]);

  /* 窗口化：一万行时 DOM 有界（FE-CHAT-023）。
     固定保留行（选中/跟随目标）独立成段渲染，不把窗口拉通到它们。 */
  const pinnedIds = useMemo(() => {
    const pinned = new Set<string>();
    if (selectedNodeId) pinned.add(selectedNodeId);
    if (followTargetId) pinned.add(followTargetId);
    return pinned;
  }, [selectedNodeId, followTargetId]);

  const windowed = rows.length > WINDOW_THRESHOLD;
  const segments = useMemo(() => {
    if (!windowed) return [{ start: 0, end: rows.length }];
    const from = scrollTop - OVERSCAN_PX;
    const to = scrollTop + host.height + OVERSCAN_PX;
    const indices = new Set<number>();
    let start = 0;
    while (
      start < rows.length &&
      layout.offsets[start] + rowHeight(rows[start]) + ROW_GAP < from
    ) {
      start += 1;
    }
    let end = start;
    while (end < rows.length && layout.offsets[end] <= to) {
      end += 1;
    }
    for (let index = start; index < end; index += 1) indices.add(index);
    rows.forEach((row, index) => {
      if (pinnedIds.has(row.id)) indices.add(index);
    });
    const sorted = [...indices].sort((left, right) => left - right);
    const result: { start: number; end: number }[] = [];
    for (const index of sorted) {
      const last = result[result.length - 1];
      if (last && index === last.end) {
        last.end = index + 1;
      } else {
        result.push({ start: index, end: index + 1 });
      }
    }
    return result;
  }, [windowed, rows, layout, scrollTop, host.height, rowHeight, pinnedIds]);

  /* 渲染块：连续行段 + 段间占位（spacer），总高恒定 */
  const blocks = useMemo(() => {
    const result: (
      | { type: "spacer"; key: string; height: number }
      | { type: "rows"; key: string; rows: ChatRow[] }
    )[] = [];
    let cursor = 0;
    segments.forEach((segment, index) => {
      const segTop = layout.offsets[segment.start];
      if (segTop > cursor) {
        result.push({
          type: "spacer",
          key: `spacer-${index}`,
          height: segTop - cursor,
        });
      }
      result.push({
        type: "rows",
        key: `rows-${segment.start}`,
        rows: rows.slice(segment.start, segment.end),
      });
      cursor =
        layout.offsets[segment.end - 1] +
        rowHeight(rows[segment.end - 1]) +
        ROW_GAP;
    });
    if (layout.total > cursor) {
      result.push({
        type: "spacer",
        key: "spacer-end",
        height: layout.total - cursor,
      });
    }
    return result;
  }, [segments, rows, layout, rowHeight]);

  /* 宿主尺寸 */
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

  /* 会话/分支/前向操作：恢复跟随（FE-CHAT-012/020） */
  useEffect(() => {
    setFollowing(true);
  }, [branchId]);

  useEffect(() => {
    useCanvasStore
      .getState()
      .activateConversationSession(sessionId, rootBranchId);
    heightsRef.current = {};
    setHeights({});
    setScrollTop(0);
    setFollowing(true);
    followScrollTopRef.current = null;
    sessionPromptReturnRef.current = null;
  }, [sessionId, rootBranchId]);

  useEffect(() => {
    if (followRequestId > 0) setFollowing(true);
  }, [followRequestId]);

  /* 滚动位置按 session+branch 保存/恢复（FE-CANVAS-022） */
  useEffect(() => {
    if (restoredScopeRef.current === conversationScope) return;
    if (rows.length === 0) return;
    restoredScopeRef.current = conversationScope;
    const frame = requestAnimationFrame(() => {
      if (wrapperRef.current) {
        restoreScrollPositions(
          wrapperRef.current,
          `conversation:${conversationScope}`,
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationScope, rows.length]);

  /* 自动跟随：贴底滚动到跟随目标（活动节点 → 门控 → 新建 → Composer） */
  useEffect(() => {
    if (!following || !followTargetId) return;
    const list = listRef.current;
    if (!list) return;
    const index = rows.findIndex((row) => row.id === followTargetId);
    if (index === -1) return;
    const targetBottom =
      layout.offsets[index] + rowHeight(rows[index]) + FOLLOW_BOTTOM_MARGIN;
    const top = Math.max(0, targetBottom - list.clientHeight);
    if (Math.abs(list.scrollTop - top) < 2) {
      followScrollTopRef.current = list.scrollTop;
      return;
    }
    programmaticUntilRef.current = Date.now() + 600;
    followScrollTopRef.current = top;
    list.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
  }, [following, followTargetId, rows, layout, rowHeight, reducedMotion]);

  /* 用户向上滚动远离跟随目标 → 暂停跟随，显示「回到最新」（FE-CHAT-012）。
     滚轮是主判定（流式期间程序滚动会持续覆盖滚动事件分析）；
     节点内长文仍能上滚时视为内部滚动，不暂停。 */
  const onListWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!following || event.deltaY >= 0) return;
      const scrollable = (event.target as Element | null)?.closest<HTMLElement>(
        ".chat-node__content--scroll",
      );
      if (scrollable && scrollable.scrollTop > 0) return;
      setFollowing(false);
    },
    [following],
  );

  const onListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      const list = event.currentTarget;
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        setScrollTop(list.scrollTop);
        if (!following) return;
        if (Date.now() < programmaticUntilRef.current) return;
        const anchor = followScrollTopRef.current;
        if (anchor !== null && list.scrollTop < anchor - PAUSE_DISTANCE_PX) {
          setFollowing(false);
        }
      });
    },
    [following],
  );
  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  /* URL 深链：切换分支、展开过程组、选择并定位目标节点（FE-CHAT-021） */
  useEffect(() => {
    if (!params.branchId || !params.nodeId) return;
    if (!conversation.branches[params.branchId]) return;
    if (params.branchId !== branchId) {
      useCanvasStore.getState().setActiveConversationBranch(params.branchId);
      return;
    }
    // 来自行点击的导航不需要重新定位：行本来就在屏幕上
    if (params.nodeId === handledSelectionRef.current) return;
    const group = projectedItems.find(
      (item) =>
        item.type === "process_group" &&
        item.members.some((member) => member.id === params.nodeId),
    );
    if (group?.type === "process_group" && !group.expanded) {
      useCanvasStore.getState().toggleProcessGroup(group.id);
      return;
    }
    // 目标不存在（刷新后快照重置、节点已消失）时不暂停跟随
    const targetExists = projectedItems.some(
      (item) => displayItemId(item) === params.nodeId,
    );
    if (!targetExists) return;
    handledSelectionRef.current = null;
    useCanvasStore.getState().setSelectedConversationNode(params.nodeId);
    setFollowing(false);
    pendingFocusRef.current = params.nodeId;
  }, [
    branchId,
    conversation.branches,
    params.branchId,
    params.nodeId,
    projectedItems,
  ]);

  /* 深链/会话确认定位：scrollIntoView；未渲染时先跳到估算位置等窗口渲染 */
  useEffect(() => {
    const targetId = pendingFocusRef.current;
    if (!targetId || following) return;
    const list = listRef.current;
    if (!list) return;
    const index = rows.findIndex((row) => row.id === targetId);
    if (index === -1) {
      pendingFocusRef.current = null;
      return;
    }
    if (windowed) {
      pendingFocusRef.current = null;
      programmaticUntilRef.current = Date.now() + 600;
      list.scrollTo({
        top: Math.max(0, layout.offsets[index] - list.clientHeight / 2),
        behavior: "auto",
      });
      return;
    }
    const element = list.querySelector<HTMLElement>(
      `[data-id="${CSS.escape(targetId)}"]`,
    );
    if (element) {
      pendingFocusRef.current = null;
      programmaticUntilRef.current = Date.now() + 600;
      element.scrollIntoView({
        block: "center",
        behavior: reducedMotion ? "auto" : "smooth",
      });
      return;
    }
    programmaticUntilRef.current = Date.now() + 600;
    list.scrollTo({
      top: Math.max(0, layout.offsets[index] - list.clientHeight / 2),
      behavior: "auto",
    });
    // scrollTop 更新后本效应重试，直到目标行进入窗口被渲染
  }, [following, rows, layout, scrollTop, reducedMotion, windowed]);

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
  const creatingSessionRef = useRef(false);
  const requestSessionMutation = useMutation({
    mutationFn: (input: {
      source_node_id: string;
      session_id: string;
      branch_id: string;
    }) =>
      getApi().requestWorkbenchAction({
        kind: "conversation_new_session",
        source_node_id: input.source_node_id,
        payload: {
          session_id: input.session_id,
          branch_id: input.branch_id,
        },
      }),
    onSettled: () => {
      creatingSessionRef.current = false;
    },
  });
  const createSessionMutation = useMutation({
    mutationFn: (idempotencyKey: string) =>
      getApi().createConversationSession({
        idempotency_key: idempotencyKey,
      }),
    onSettled: () => {
      creatingSessionRef.current = false;
    },
  });
  const creatingSession =
    requestSessionMutation.isPending || createSessionMutation.isPending;

  /* 新建会话确认：暂停跟随并定位确认行；关闭后恢复原滚动位置（FE-CHAT-025） */
  useEffect(() => {
    const list = listRef.current;
    if (!pendingNewSessionAction) {
      const previous = sessionPromptReturnRef.current;
      if (previous && previous.sessionId === sessionId && list) {
        sessionPromptReturnRef.current = null;
        programmaticUntilRef.current = Date.now() + 600;
        list.scrollTo({
          top: previous.scrollTop,
          behavior: reducedMotion ? "auto" : "smooth",
        });
      }
      return;
    }
    if (!list || sessionPromptReturnRef.current) return;
    sessionPromptReturnRef.current = {
      sessionId,
      scrollTop: list.scrollTop,
    };
    setFollowing(false);
    pendingFocusRef.current = ACTION_CONFIRM_ID(pendingNewSessionAction.id);
  }, [pendingNewSessionAction, sessionId, reducedMotion]);

  useEffect(() => {
    if (sessionPromptReturnRef.current?.sessionId !== sessionId) {
      sessionPromptReturnRef.current = null;
    }
  }, [sessionId]);

  const createSession = useCallback(() => {
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
    const sourceId = rows.at(-1)?.id ?? `composer:${branchId}`;
    if (hasDraft || active.length > 0 || inputGate) {
      creatingSessionRef.current = true;
      requestSessionMutation.mutate({
        source_node_id: sourceId,
        session_id: sessionId,
        branch_id: branchId,
      });
      return;
    }
    creatingSessionRef.current = true;
    createSessionMutation.mutate(crypto.randomUUID());
  }, [
    branchId,
    conversation,
    conversationScope,
    creatingSession,
    createSessionMutation,
    inputGate,
    pendingNewSessionAction,
    requestSessionMutation,
    rows,
    sessionId,
  ]);

  /* 行点击：只选择 + 深链导航，不滚动（FE-CHAT-020 手动浏览不抢焦点） */
  const onRowClick = useCallback(
    (row: ChatRow, event: React.MouseEvent) => {
      if (row.kind !== "item" || row.item.type !== "node") return;
      if (
        (event.target as Element | null)?.closest(
          "button,input,textarea,select,a",
        )
      ) {
        return;
      }
      const nodeId = row.item.node.id;
      handledSelectionRef.current = nodeId;
      useCanvasStore.getState().setSelectedConversationNode(nodeId);
      setFollowing(false);
      navigate(`/canvas/chat/branches/${branchId}/nodes/${nodeId}`);
    },
    [branchId, navigate],
  );

  return (
    <div
      ref={wrapperRef}
      className="conversation-graph"
      onScrollCapture={(event) =>
        persistScrollPosition(event.target, `conversation:${conversationScope}`)
      }
    >
      <div className="chat-toolbar nodrag nowheel">
        {branches.map((branch) => {
          const label = branchLabel(branch, rootBranchId, conversation.nodes);
          return (
            <button
              key={branch.id}
              type="button"
              className="chat-toolbar__branch"
              data-active={branch.id === branchId || undefined}
              title={label.title}
              aria-label={label.title}
              onClick={() =>
                useCanvasStore.getState().setActiveConversationBranch(branch.id)
              }
            >
              {label.text}
            </button>
          );
        })}
        {connection !== "open" ? (
          <span className="chat-toolbar__connection" role="status">
            事件流{connection === "retrying" ? "重连中" : "连接中"}…
          </span>
        ) : null}
      </div>
      <div
        ref={listRef}
        className="chat-list nodrag nowheel"
        data-scroll-key="chat-list"
        role="list"
        aria-label="对话消息列表"
        onScroll={onListScroll}
        onWheel={onListWheel}
      >
        {blocks.map((block) =>
          block.type === "spacer" ? (
            <div
              key={block.key}
              style={{ height: block.height }}
              aria-hidden="true"
            />
          ) : (
            block.rows.map((row) => (
              <div
                key={row.id}
                className="chat-row"
                data-id={row.id}
                role="listitem"
                ref={setRowRef(row.id)}
                onClick={(event) => onRowClick(row, event)}
              >
                <div className="chat-row__inner">
                  <RowContent
                    row={row}
                    sessionId={sessionId}
                    branchId={branchId}
                    selectedNodeId={selectedNodeId}
                  />
                </div>
              </div>
            ))
          ),
        )}
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
          onClick={() => {
            useCanvasStore.getState().requestConversationFollow();
            // 清掉 URL 上可能失效的深链 nodeId，避免残留目标干扰跟随
            navigate("/", { replace: true });
          }}
        >
          ↓ 回到最新
        </button>
      ) : null}
    </div>
  );
});

/** 中央对话列表：节点外观的垂直对话流（02 §5；v1 起不再是嵌套画布） */
export const ConversationGraph = memo(function ConversationGraph() {
  return <ConversationGraphInner />;
});
