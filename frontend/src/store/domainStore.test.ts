import { beforeEach, describe, expect, it } from "vitest";
import { FakeBackend } from "../api/mock/backend";
import {
  EVENT_SCHEMA_VERSION,
  type EventEnvelope,
  type EventType,
  type Notification,
  type ConversationNode,
  type ConversationSession,
} from "../api/types";
import { selectNotificationQueue } from "../notifications/queue";
import { useDomainStore } from "./domainStore";

function makeNotification(
  partial: Partial<Notification> & Pick<Notification, "id">,
): Notification {
  return {
    severity: "warning",
    message: `msg-${partial.id}`,
    source_workbench: "system",
    source_node_id: null,
    lifecycle: "active",
    raised_at: "2026-01-01T00:00:00.000Z",
    acknowledged_at: null,
    resolved_at: null,
    ...partial,
  };
}

function envelope<T extends EventType>(
  sequence: number,
  eventType: T,
  payload: EventEnvelope<T>["payload"],
): EventEnvelope<T> {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    sequence,
    event_id: `e-${sequence}`,
    occurred_at: "2026-01-01T00:00:00.000Z",
    aggregate_type: "notification",
    aggregate_id: "ntf",
    event_type: eventType,
    payload,
  };
}

beforeEach(() => {
  useDomainStore.setState({
    snapshotLoaded: false,
    lastSequence: 0,
    notifications: {},
  });
});

describe("通知生命周期投影（FE-PET-009/010、PRD-NOTIFY-007）", () => {
  it("同一通知 ID 重复 raised：更新内容而不重复入列", () => {
    const { applyEvent } = useDomainStore.getState();
    applyEvent(
      envelope(1, "notification.raised", {
        notification: makeNotification({ id: "ntf-1", message: "第一版" }),
      }),
    );
    applyEvent(
      envelope(2, "notification.raised", {
        notification: makeNotification({ id: "ntf-1", message: "更新版" }),
      }),
    );
    const { notifications } = useDomainStore.getState();
    expect(Object.keys(notifications)).toEqual(["ntf-1"]);
    expect(notifications["ntf-1"].message).toBe("更新版");
    expect(useDomainStore.getState().lastSequence).toBe(2);
  });

  it("acknowledged 与 resolved 分开呈现：确认不解除，解除才离场", () => {
    const { applyEvent } = useDomainStore.getState();
    applyEvent(
      envelope(1, "notification.raised", {
        notification: makeNotification({ id: "ntf-1", severity: "error" }),
      }),
    );
    applyEvent(
      envelope(2, "notification.acknowledged", {
        notification_id: "ntf-1",
        acknowledged_at: "2026-01-01T00:01:00.000Z",
      }),
    );
    let queue = selectNotificationQueue(
      useDomainStore.getState().notifications,
    );
    // 阻断项 acknowledged 后仍可从宠物再次访问（确认 ≠ 解除）
    expect(queue.map((n) => n.id)).toEqual(["ntf-1"]);
    expect(queue[0].lifecycle).toBe("acknowledged");
    expect(queue[0].acknowledged_at).toBe("2026-01-01T00:01:00.000Z");

    applyEvent(
      envelope(3, "notification.resolved", {
        notification_id: "ntf-1",
        resolved_at: "2026-01-01T00:02:00.000Z",
      }),
    );
    queue = selectNotificationQueue(useDomainStore.getState().notifications);
    expect(queue).toEqual([]);
    const resolved = useDomainStore.getState().notifications["ntf-1"];
    expect(resolved.lifecycle).toBe("resolved");
    expect(resolved.resolved_at).toBe("2026-01-01T00:02:00.000Z");
  });

  it("acknowledge/resolve 未知通知 id：忽略而不崩溃", () => {
    const { applyEvent } = useDomainStore.getState();
    applyEvent(
      envelope(1, "notification.acknowledged", {
        notification_id: "ntf-ghost",
        acknowledged_at: "2026-01-01T00:01:00.000Z",
      }),
    );
    applyEvent(
      envelope(2, "notification.resolved", {
        notification_id: "ntf-ghost",
        resolved_at: "2026-01-01T00:02:00.000Z",
      }),
    );
    expect(useDomainStore.getState().notifications).toEqual({});
    expect(useDomainStore.getState().lastSequence).toBe(2);
  });

  it("启动快照先恢复未解决通知，再消费后续事件（FE-PET-009）", async () => {
    const backend = new FakeBackend();
    const snapshot = await backend.getSnapshot();
    snapshot.state.notifications.push(
      makeNotification({ id: "ntf-snap", severity: "action_required" }),
    );
    useDomainStore.getState().initFromSnapshot(snapshot);
    const state = useDomainStore.getState();
    expect(state.snapshotLoaded).toBe(true);
    expect(state.lastSequence).toBe(snapshot.last_sequence);
    expect(state.notifications["ntf-snap"].lifecycle).toBe("active");
    expect(
      selectNotificationQueue(state.notifications).map((n) => n.id),
    ).toContain("ntf-snap");
  });

  it("未知扩展事件：忽略但不崩溃（FE-EVENT-007）", () => {
    const { applyEvent } = useDomainStore.getState();
    const foreign = envelope(1, "notification.raised", {
      notification: makeNotification({ id: "ntf-1" }),
    }) as EventEnvelope;
    foreign.event_type = "future.extension" as EventEnvelope["event_type"];
    expect(() => applyEvent(foreign)).not.toThrow();
    expect(useDomainStore.getState().notifications).toEqual({});
  });
});

describe("多会话事件投影", () => {
  it("迟到的旧图事件只更新旧会话，不污染当前空会话", async () => {
    const snapshot = await new FakeBackend().getSnapshot();
    useDomainStore.getState().initFromSnapshot(snapshot);
    const oldSession = snapshot.state.conversation.sessions[0];
    const nextSession: ConversationSession = {
      id: "s-next",
      graph_id: "g-next",
      root_branch_id: "b-next",
      created_at: "2026-01-01T00:01:00.000Z",
      updated_at: "2026-01-01T00:01:00.000Z",
    };
    const created = envelope(1, "conversation.session.created", {
      session: nextSession,
      graph: {
        graph_id: nextSession.graph_id,
        root_branch_id: nextSession.root_branch_id,
        nodes: [],
        branches: [
          {
            id: nextSession.root_branch_id,
            graph_id: nextSession.graph_id,
            anchor_node_id: null,
            parent_branch_id: null,
            created_at: nextSession.created_at,
          },
        ],
      },
      active: true,
    });
    created.aggregate_type = "conversation";
    created.aggregate_id = nextSession.graph_id;
    useDomainStore.getState().applyEvent(created);

    const lateNode: ConversationNode = {
      id: "n-late-old",
      graph_id: oldSession.graph_id,
      kind: "assistant_answer",
      state: "aborted",
      content: "旧会话迟到内容",
      node_sequence: 1,
      intent: "question",
      parent_ids: [],
      branch_ids: [oldSession.root_branch_id],
      created_at: "2026-01-01T00:00:30.000Z",
      completed_at: "2026-01-01T00:01:01.000Z",
      requirement_id: null,
      requirement_revision: null,
      clarification_round_id: null,
      redacted_at: null,
      tool_activity: null,
    };
    const late = envelope(2, "conversation.node.created", {
      node: lateNode,
    });
    late.aggregate_type = "conversation";
    late.aggregate_id = oldSession.graph_id;
    useDomainStore.getState().applyEvent(late);

    const state = useDomainStore.getState();
    expect(state.activeConversationSessionId).toBe(nextSession.id);
    expect(state.conversation.nodes).toEqual({});
    expect(state.conversationGraphs[oldSession.id].nodes[lateNode.id]).toEqual(
      lateNode,
    );
    expect(state.recentConversationNodeId).toBeNull();
  });
});
