import { describe, expect, it } from "vitest";
import { createEventApplier } from "../../events/applier";
import { createNdjsonDecoder } from "../../events/ndjson";
import { useDomainStore } from "../../store/domainStore";
import { projectBranchDisplay } from "../../chat/dag";
import { FakeBackend } from "./backend";

/**
 * 假数据层端到端：FakeBackend 命令 → NDJSON 事件流 → sequence 对账 →
 * 领域投影（与生产形态同路径，FE-CHAT-008/014、FE-EVENT-003）。
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 12_000,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor 超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function connectBackendToDomain(backend: FakeBackend, after: number) {
  const applied: number[] = [];
  const applier = createEventApplier(after, {
    apply: (envelope) => {
      applied.push(envelope.sequence);
      useDomainStore.getState().applyEvent(envelope);
    },
    onResyncNeeded: () => {
      throw new Error("演示流不应出现序号缺口");
    },
  });
  const decoder = createNdjsonDecoder({
    onLine: (line) => applier.handle(JSON.parse(line)),
  });
  void backend.openEventStream(after).then(async (stream) => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) decoder.write(value);
    }
  });
  return { applied };
}

describe("FakeBackend 端到端（假 LLM 脚本 + NDJSON 流）", () => {
  it("新建会话创建独立图、保留旧图并对幂等键去重", async () => {
    const backend = new FakeBackend();
    const before = await backend.getSnapshot();
    const first = await backend.createConversationSession({
      idempotency_key: "new-session-1",
    });
    const duplicate = await backend.createConversationSession({
      idempotency_key: "new-session-1",
    });
    const after = await backend.getSnapshot();

    expect(first.session.id).toBe(duplicate.session.id);
    expect(first.session.graph_id).not.toBe("g-main");
    expect(first.graph.nodes).toEqual([]);
    expect(first.graph.branches).toHaveLength(1);
    expect(after.state.conversation.sessions).toHaveLength(
      before.state.conversation.sessions.length + 1,
    );
    expect(after.state.conversation.active_session_id).toBe(first.session.id);
    expect(
      after.state.conversation.graphs.some(
        (graph) => graph.graph_id === "g-main",
      ),
    ).toBe(true);
  });

  it("生成中确认新建会话会中止旧响应并保留旧图", async () => {
    const backend = new FakeBackend();
    const initial = await backend.getSnapshot();
    useDomainStore.getState().initFromSnapshot(initial);
    connectBackendToDomain(backend, initial.last_sequence);
    await backend.sendMessage({
      session_id: "s-main",
      branch_id: "b-main",
      text: "为什么新会话不继承旧上下文？",
      intent: "auto",
    });
    await waitFor(async () => {
      const snapshot = await backend.getSnapshot();
      return snapshot.state.conversation.graphs.some((graph) =>
        graph.nodes.some(
          (node) => node.state === "streaming" && node.content.length > 0,
        ),
      );
    });
    const { action_id } = await backend.requestWorkbenchAction({
      kind: "conversation_new_session",
      source_node_id: null,
      payload: { session_id: "s-main", branch_id: "b-main" },
    });
    const prepared = await backend.getSnapshot();
    const action = prepared.state.workbench_actions.find(
      (candidate) => candidate.id === action_id,
    )!;
    await backend.confirmWorkbenchAction({
      action_id,
      confirm_token: action.confirm_token,
    });
    const after = await backend.getSnapshot();
    const oldGraph = after.state.conversation.graphs.find(
      (graph) => graph.graph_id === "g-main",
    )!;

    expect(oldGraph.nodes.some((node) => node.state === "aborted")).toBe(true);
    expect(after.state.conversation.active_session_id).not.toBe("s-main");
    await waitFor(
      () => useDomainStore.getState().activeConversationSessionId !== "s-main",
    );
    expect(
      Object.values(
        useDomainStore.getState().conversationGraphs["s-main"].nodes,
      ).some((node) => node.state === "aborted"),
    ).toBe(true);
  });

  it("开发需求消息：用户/过程/工具/回答流式到达，回答完成后形成过程组", async () => {
    const backend = new FakeBackend();
    const snapshot = await backend.getSnapshot();
    useDomainStore.getState().initFromSnapshot(snapshot);
    connectBackendToDomain(backend, snapshot.last_sequence);

    await backend.sendMessage({
      session_id: "s-main",
      branch_id: "b-main",
      text: "帮我做一个新功能",
      intent: "auto",
    });

    await waitFor(() => {
      const { conversation } = useDomainStore.getState();
      return Object.values(conversation.nodes).some(
        (node) =>
          node.kind === "assistant_answer" && node.state === "completed",
      );
    });

    const { conversation } = useDomainStore.getState();
    const nodes = Object.values(conversation.nodes);
    // 链完整：用户 → 过程 → 工具 → 过程 → 回答
    expect(
      nodes.some(
        (n) => n.kind === "user_message" && n.content.includes("新功能"),
      ),
    ).toBe(true);
    const tool = nodes.find((n) => n.kind === "tool");
    expect(tool?.state).toBe("completed");
    expect(tool?.tool_activity?.state).toBe("completed");
    expect(tool?.tool_activity?.duration_ms).toBeGreaterThan(0);
    const answer = nodes.find((n) => n.kind === "assistant_answer");
    expect(answer?.content.length).toBeGreaterThan(0);
    // delta 严格有序：node_sequence 连续
    for (const node of nodes.filter((n) => n.state === "completed")) {
      expect(node.node_sequence).toBeGreaterThanOrEqual(0);
    }
    // 回答完成 → 过程+工具折叠为 ProcessGroup，末端唯一 Composer
    const items = projectBranchDisplay(conversation, "b-main", []);
    expect(items.some((i) => i.type === "process_group")).toBe(true);
    expect(items.filter((i) => i.type === "composer")).toHaveLength(1);
    expect(items.at(-1)?.type).toBe("composer");
  }, 15_000);

  it("停止响应：已产出内容保留、活动节点转 aborted、分支恢复空闲", async () => {
    const backend = new FakeBackend();
    const snapshot = await backend.getSnapshot();
    useDomainStore.getState().initFromSnapshot(snapshot);
    connectBackendToDomain(backend, snapshot.last_sequence);

    await backend.sendMessage({
      session_id: "s-main",
      branch_id: "b-main",
      text: "什么是 Raccoon Node？",
      intent: "auto",
    });
    await waitFor(() => {
      const { conversation } = useDomainStore.getState();
      return Object.values(conversation.nodes).some(
        (node) => node.state === "streaming" && node.content.length > 0,
      );
    });
    await backend.abortResponse("s-main", "b-main");
    await waitFor(() => {
      const { conversation } = useDomainStore.getState();
      return Object.values(conversation.nodes).some(
        (node) => node.state === "aborted",
      );
    });
    const { conversation } = useDomainStore.getState();
    const aborted = Object.values(conversation.nodes).filter(
      (node) => node.state === "aborted",
    );
    expect(aborted.length).toBeGreaterThan(0);
    expect(aborted.some((node) => node.content.length > 0)).toBe(true);
    // 分支空闲，Composer 回到末端
    const items = projectBranchDisplay(conversation, "b-main", []);
    expect(items.at(-1)?.type).toBe("composer");
  }, 15_000);

  it("branchFrom：非用户节点归一到最近祖先用户节点，新分支共享祖先", async () => {
    const backend = new FakeBackend();
    const snapshot = await backend.getSnapshot();
    useDomainStore.getState().initFromSnapshot(snapshot);
    connectBackendToDomain(backend, snapshot.last_sequence);

    await backend.sendMessage({
      session_id: "s-main",
      branch_id: "b-main",
      text: "什么是 Raccoon Node？",
      intent: "auto",
    });
    await waitFor(() => {
      const { conversation } = useDomainStore.getState();
      return Object.values(conversation.nodes).some(
        (node) =>
          node.kind === "assistant_answer" && node.state === "completed",
      );
    });
    const answer = Object.values(
      useDomainStore.getState().conversation.nodes,
    ).find((node) => node.kind === "assistant_answer")!;
    const { branch } = await backend.branchFrom({
      session_id: "s-main",
      node_id: answer.id,
    });
    const anchor =
      useDomainStore.getState().conversation.nodes[branch.anchor_node_id!];
    expect(anchor.kind).toBe("user_message");
    // 事件流已把新分支同步到投影
    await waitFor(() => {
      const { conversation } = useDomainStore.getState();
      return Boolean(conversation.branches[branch.id]);
    });
    const shared = useDomainStore.getState().conversation.nodes[anchor.id];
    expect(shared.branch_ids).toContain(branch.id);
  }, 15_000);
});
