import {
  capabilityCheckMessage,
  checkRoleCapability,
  ROLE_LABELS,
} from "../modelCaps";
import type {
  DomainEventPayload,
  EventAggregateType,
  EventType,
  ModelCapability,
  ModelInfo,
  ModelRef,
  ModelRole,
  ProviderInfo,
  RoleAssignResult,
  RoleProfile,
} from "../types";

type Emit = <T extends EventType>(
  aggregateType: EventAggregateType,
  aggregateId: string,
  eventType: T,
  payload: DomainEventPayload[T],
) => void;

const now = () => new Date().toISOString();

const caps = (overrides: Partial<ModelCapability> = {}): ModelCapability => ({
  text: "supported",
  image: "unknown",
  streaming: "supported",
  tools: "supported",
  structured_output: "supported",
  long_context: "supported",
  ...overrides,
});

const model = (
  provider_id: string,
  id: string,
  label: string,
  capabilities: ModelCapability,
): ModelInfo => ({ id, provider_id, label, capabilities });

/**
 * 模型配置模块（假数据层）：
 * Provider/模型/五角色配置与能力校验（PRD-MODEL-003/004）、
 * 凭据只新建替换不回显（PRD-MODEL-005）。
 */
export class ModelsModule {
  private providers: ProviderInfo[] = [
    {
      id: "fake-chat",
      label: "FakeChat",
      auth_fields: ["API Key"],
      credential: "configured",
      models: [
        model(
          "fake-chat",
          "fake-chat-pro",
          "FakeChat Pro",
          caps({ image: "supported" }),
        ),
        model(
          "fake-chat",
          "fake-chat-mini",
          "FakeChat Mini",
          caps({
            tools: "unsupported",
            structured_output: "unknown",
            long_context: "unknown",
          }),
        ),
      ],
    },
    {
      id: "fake-large",
      label: "FakeLarge",
      auth_fields: ["API Key", "Organization"],
      credential: "missing",
      models: [
        model(
          "fake-large",
          "fake-large-a",
          "FakeLarge A",
          caps({ image: "supported" }),
        ),
        model(
          "fake-large",
          "fake-large-b",
          "FakeLarge B",
          caps({
            structured_output: "unsupported",
            long_context: "unsupported",
          }),
        ),
      ],
    },
  ];

  private roles: RoleProfile[] = [
    { role: "qa", primary: "fake-chat/fake-chat-pro", fallback: null },
    { role: "clarifier", primary: "fake-chat/fake-chat-pro", fallback: null },
    { role: "planner", primary: "fake-large/fake-large-a", fallback: null },
    {
      role: "implementer",
      primary: "fake-large/fake-large-a",
      fallback: "fake-chat/fake-chat-pro",
    },
    { role: "reviewer", primary: "fake-large/fake-large-a", fallback: null },
  ];

  private lastResult: RoleAssignResult = null;

  constructor(
    private readonly deps: {
      emit: Emit;
      latency: () => Promise<void>;
    },
  ) {}

  private publish() {
    this.deps.emit("models", "registry", "models.updated", {
      providers: this.providers,
      roles: this.roles,
      last_result: this.lastResult,
    });
  }

  snapshotState() {
    return {
      providers: this.providers,
      roles: this.roles,
      last_result: this.lastResult,
    };
  }

  private findModel(ref: ModelRef): ModelInfo | null {
    const [providerId, modelId] = ref.split("/");
    const provider = this.providers.find((entry) => entry.id === providerId);
    return provider?.models.find((entry) => entry.id === modelId) ?? null;
  }

  async setProviderCredential(input: {
    provider_id: string;
    secret: string;
  }): Promise<void> {
    await this.deps.latency();
    const provider = this.providers.find(
      (entry) => entry.id === input.provider_id,
    );
    if (!provider) return;
    // 凭据只新建/替换，不回显（PRD-MODEL-005）；空输入视为无效
    provider.credential = input.secret.trim() ? "configured" : "invalid";
    this.publish();
  }

  async assignRoleModel(input: {
    role: ModelRole;
    slot: "primary" | "fallback";
    model: ModelRef | null;
  }): Promise<{ ok: boolean; message: string }> {
    await this.deps.latency();
    const profile = this.roles.find((entry) => entry.role === input.role);
    if (!profile) return { ok: false, message: `未知角色：${input.role}` };
    if (input.model === null) {
      if (input.slot === "primary") {
        const message = `${ROLE_LABELS[input.role]}角色必须配置主模型，保存已被阻止。`;
        this.lastResult = { ok: false, message, at: now() };
        this.publish();
        return { ok: false, message };
      }
      profile.fallback = null;
      const message = `已清除${ROLE_LABELS[input.role]}角色的回退模型。`;
      this.lastResult = { ok: true, message, at: now() };
      this.publish();
      return { ok: true, message };
    }
    const target = this.findModel(input.model);
    if (!target) return { ok: false, message: `模型不存在：${input.model}` };
    // 能力校验（PRD-MODEL-004）：不满足角色能力要求时保存被阻止
    const check = checkRoleCapability(input.role, target.capabilities);
    if (!check.ok) {
      const message = capabilityCheckMessage(input.role, target.label, check);
      this.lastResult = { ok: false, message, at: now() };
      this.publish();
      return { ok: false, message };
    }
    profile[input.slot] = input.model;
    const slotLabel = input.slot === "primary" ? "主模型" : "回退模型";
    const message = `已保存：${ROLE_LABELS[input.role]}角色${slotLabel} = ${target.label}。`;
    this.lastResult = { ok: true, message, at: now() };
    this.publish();
    return { ok: true, message };
  }

  summaryLines(): string[] {
    const missing = this.roles.filter((profile) => !profile.primary).length;
    return [
      `Provider ${this.providers.length} · 模型 ${this.providers.reduce((n, p) => n + p.models.length, 0)}`,
      missing > 0 ? `角色缺口 ${missing}` : "五角色已配置",
      "模型配置已并入设置",
    ];
  }
}
