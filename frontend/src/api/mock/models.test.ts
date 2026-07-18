import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../types";
import { ModelsModule } from "./models";

function makeModels() {
  const events: EventEnvelope[] = [];
  const module = new ModelsModule({
    emit: (aggregateType, aggregateId, eventType, payload) => {
      events.push({
        schema_version: 1,
        sequence: events.length + 1,
        event_id: `e-${events.length + 1}`,
        occurred_at: new Date().toISOString(),
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        event_type: eventType,
        payload,
      } as EventEnvelope);
    },
    latency: () => Promise.resolve(),
  });
  return { module, events };
}

describe("模型角色能力校验（FE-MODEL-002、PRD-MODEL-004）", () => {
  it("不支持工具调用的模型配给任何角色都被阻止", async () => {
    const { module } = makeModels();
    const result = await module.assignRoleModel({
      role: "implementer",
      slot: "primary",
      model: "fake-chat/fake-chat-mini",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("工具调用");
    // 保存被阻止：角色配置不变
    const implementer = module
      .snapshotState()
      .roles.find((profile) => profile.role === "implementer");
    expect(implementer?.primary).toBe("fake-large/fake-large-a");
    expect(module.snapshotState().last_result?.ok).toBe(false);
  });

  it("结构化输出/长上下文缺失的模型不能承担 reviewer", async () => {
    const { module } = makeModels();
    const result = await module.assignRoleModel({
      role: "reviewer",
      slot: "primary",
      model: "fake-large/fake-large-b",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("结构化输出");
  });

  it("满足能力的保存成功并投影", async () => {
    const { module, events } = makeModels();
    const result = await module.assignRoleModel({
      role: "qa",
      slot: "primary",
      model: "fake-chat/fake-chat-pro",
    });
    expect(result.ok).toBe(true);
    expect(module.snapshotState().last_result?.ok).toBe(true);
    expect(events.some((event) => event.event_type === "models.updated")).toBe(
      true,
    );
  });

  it("清除回退 / 主模型不可为空", async () => {
    const { module } = makeModels();
    const cleared = await module.assignRoleModel({
      role: "implementer",
      slot: "fallback",
      model: null,
    });
    expect(cleared.ok).toBe(true);
    const blocked = await module.assignRoleModel({
      role: "qa",
      slot: "primary",
      model: null,
    });
    expect(blocked.ok).toBe(false);
  });
});

describe("模型凭据", () => {
  it("凭据只新建/替换不回显", async () => {
    const { module } = makeModels();
    await module.setProviderCredential({
      provider_id: "fake-large",
      secret: "sk-demo",
    });
    const provider = module
      .snapshotState()
      .providers.find((entry) => entry.id === "fake-large");
    expect(provider?.credential).toBe("configured");
    // 快照不含密钥内容
    expect(JSON.stringify(module.snapshotState())).not.toContain("sk-demo");
  });
});
