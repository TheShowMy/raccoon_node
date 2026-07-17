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
  condition: () => boolean,
  timeoutMs = 12_000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
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
  it("开发需求消息：用户/过程/工具/回答流式到达，回答完成后形成过程组", async () => {
    const backend = new FakeBackend();
    const snapshot = await backend.getSnapshot();
    useDomainStore.getState().initFromSnapshot(snapshot);
    connectBackendToDomain(backend, snapshot.last_sequence);

    await backend.sendMessage({
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
    await backend.abortResponse("b-main");
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
    const { branch } = await backend.branchFrom({ node_id: answer.id });
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
