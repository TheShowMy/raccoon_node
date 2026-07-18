import { PixelButton } from "@pxlkit/ui-kit";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import type { Notification } from "../../api/types";
import { branchActiveNodes } from "../../chat/dag";
import {
  isBlocking,
  readingDurationMs,
  selectNotificationQueue,
} from "../../notifications/queue";
import { useAppearanceStore } from "../../store/appearanceStore";
import { useCanvasStore } from "../../store/canvasStore";
import { useDomainStore } from "../../store/domainStore";
import { deliveryNodeId } from "../../workbenches/delivery/projection";
import GrayDangoPet from "./GrayDangoPet";
import {
  deriveGrayDangoPresentation,
  type GrayDangoActivity,
} from "./graydangoModel";

const SEVERITY_LABELS: Record<Notification["severity"], string> = {
  error: "错误",
  action_required: "待操作",
  warning: "警告",
  success: "完成",
  info: "信息",
};

/**
 * GrayDango 宿主（02 §8）：唯一全局通知入口。
 * 气泡为队列形态：前后浏览 / 位置 x-y / 确认 / 定位；
 * 普通通知按阅读时长自动收起，阻断项持久可再次访问（FE-PET-004/005）。
 */
export function GrayDangoHost({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const navigate = useNavigate();
  const notifications = useDomainStore((state) => state.notifications);
  const conversation = useDomainStore((state) => state.conversation);
  const activeBranchId = useCanvasStore(
    (state) => state.activeConversationBranchId ?? conversation.root_branch_id,
  );

  // 外观偏好（FE-SET-003）：关闭非关键气泡后，错误/阻断/待操作/警告仍自动可见
  const nonCriticalBubbles = useAppearanceStore(
    (state) => state.nonCriticalBubbles,
  );
  const petAnimation = useAppearanceStore((state) => state.petAnimation);

  const queue = useMemo(() => {
    const all = selectNotificationQueue(notifications);
    if (nonCriticalBubbles) return all;
    return all.filter(
      (notification) =>
        notification.severity !== "success" && notification.severity !== "info",
    );
  }, [notifications, nonCriticalBubbles]);
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const current =
    queue.length === 0 ? null : queue[Math.min(index, queue.length - 1)];

  const activity = useMemo<GrayDangoActivity>(() => {
    const active = branchActiveNodes(conversation, activeBranchId);
    const tool = active.find(
      (node) => node.kind === "tool" && node.state === "running",
    );
    if (tool) return { kind: "tool", name: tool.tool_activity?.name ?? "tool" };
    if (active.some((node) => node.kind === "assistant_answer")) {
      return { kind: "responding" };
    }
    if (active.length > 0) return { kind: "thinking" };
    return { kind: "idle" };
  }, [conversation, activeBranchId]);

  const presentation = useMemo(
    () =>
      deriveGrayDangoPresentation({
        top: current
          ? { severity: current.severity, message: current.message }
          : null,
        activity,
      }),
    [current, activity],
  );

  // 新通知到达时展开并跳到队首；阻断项永不自动收起（FE-PET-004）
  const firstId = queue[0]?.id ?? null;
  useEffect(() => {
    if (firstId) {
      setIndex(0);
      setCollapsed(false);
    }
  }, [firstId]);

  // 普通通知按可访问阅读时长自动收起
  useEffect(() => {
    if (!current || isBlocking(current)) return;
    const timer = window.setTimeout(
      () => setCollapsed(true),
      readingDurationMs(current.message),
    );
    return () => window.clearTimeout(timer);
  }, [current]);

  const locate = (notification: Notification) => {
    const canvas = useCanvasStore.getState();
    const domain = useDomainStore.getState();
    if (notification.source_workbench === "conversation") {
      // FE-PET-007：聚焦中央对话图对应分支节点，不打开工作台
      const nodeId = notification.source_node_id;
      const node = nodeId ? domain.conversation.nodes[nodeId] : null;
      if (!node) return;
      const branchId = node.branch_ids.includes(activeBranchId)
        ? activeBranchId
        : node.branch_ids[node.branch_ids.length - 1];
      canvas.setActiveConversationBranch(branchId);
      canvas.setSelectedConversationNode(node.id);
      navigate(`/canvas/chat/branches/${branchId}/nodes/${node.id}`);
      return;
    }
    if (notification.source_workbench !== "system") {
      // FE-PET-007：delivery 来源经深链打开工作台并聚焦来源节点
      // （source_node_id 为 run id 或 requirement id，由 DeliveryWorkbench 聚焦）
      if (
        notification.source_workbench === "delivery" &&
        notification.source_node_id
      ) {
        const sourceId = notification.source_node_id;
        if (useDomainStore.getState().runs[sourceId]) {
          canvas.requestDeliveryFocus(deliveryNodeId.run(sourceId));
          navigate(`/canvas/workbenches/delivery/runs/${sourceId}`);
        } else if (
          Object.values(useDomainStore.getState().plans).some((plan) =>
            plan.items.some((item) => item.id === sourceId),
          )
        ) {
          const plan = Object.values(useDomainStore.getState().plans).find(
            (entry) => entry.items.some((item) => item.id === sourceId),
          )!;
          canvas.requestDeliveryFocus(deliveryNodeId.workItem(sourceId));
          navigate(`/canvas/workbenches/delivery/runs/${plan.run_id}`);
        } else {
          canvas.requestDeliveryFocus(deliveryNodeId.requirement(sourceId));
          navigate(`/canvas/workbenches/delivery/requirements/${sourceId}`);
        }
        return;
      }
      // 普通工作台没有内部画布定位；通知只负责按射线流程打开工作台。
      navigate(`/canvas/workbenches/${notification.source_workbench}`);
    }
  };

  const announcement = current
    ? `${SEVERITY_LABELS[current.severity]}通知：${current.message}，第 ${Math.min(index, queue.length - 1) + 1} 条，共 ${queue.length} 条`
    : "";

  return (
    <>
      <GrayDangoPet
        presentation={
          petAnimation
            ? { ...presentation, bubble: null }
            : // 关闭动画时使用静态表现（FE-PET-002）
              { ...presentation, bubble: null, animation: "idle", frames: 1 }
        }
        containerRef={containerRef}
      >
        {current && !collapsed ? (
          <section
            className="graydango-queue px-cut px-shadowed"
            data-severity={current.severity}
            aria-label="通知队列"
          >
            <p className="graydango-queue__message">
              <strong>[{SEVERITY_LABELS[current.severity]}]</strong>{" "}
              {current.message}
              {current.lifecycle === "acknowledged" ? "（已确认，未解决）" : ""}
            </p>
            <div className="graydango-queue__controls">
              <button
                type="button"
                aria-label="前一条通知"
                disabled={queue.length < 2}
                onClick={() =>
                  setIndex((value) => (value - 1 + queue.length) % queue.length)
                }
              >
                ←
              </button>
              <span
                aria-label={`第 ${Math.min(index, queue.length - 1) + 1} 条，共 ${queue.length} 条`}
              >
                {Math.min(index, queue.length - 1) + 1}/{queue.length}
              </span>
              <button
                type="button"
                aria-label="后一条通知"
                disabled={queue.length < 2}
                onClick={() => setIndex((value) => (value + 1) % queue.length)}
              >
                →
              </button>
              <PixelButton
                size="sm"
                tone="green"
                variant="outline"
                disabled={current.lifecycle !== "active"}
                onClick={() =>
                  void useDomainStore
                    .getState()
                    .acknowledgeNotification(current.id)
                }
              >
                确认
              </PixelButton>
              <PixelButton
                size="sm"
                tone="cyan"
                variant="outline"
                disabled={notificationLocateDisabled(current)}
                onClick={() => locate(current)}
              >
                定位
              </PixelButton>
            </div>
          </section>
        ) : null}
        {current && collapsed ? (
          <button
            type="button"
            className="graydango-queue-indicator"
            aria-label={`展开通知队列，共 ${queue.length} 条`}
            onClick={() => setCollapsed(false)}
          >
            {queue.length}
          </button>
        ) : null}
      </GrayDangoPet>
      <span
        className="sr-only"
        aria-live={current && isBlocking(current) ? "assertive" : "polite"}
      >
        {announcement}
      </span>
    </>
  );
}

function notificationLocateDisabled(notification: Notification): boolean {
  if (notification.source_workbench === "system") return true;
  if (notification.source_workbench === "conversation") {
    return !notification.source_node_id;
  }
  return false;
}
