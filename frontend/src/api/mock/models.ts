import {
  capabilityCheckMessage,
  checkRoleCapability,
  ROLE_LABELS,
} from "../modelCaps";
import { evaluateSoftThreshold } from "../usage";
import type {
  DomainEventPayload,
  EventAggregateType,
  EventType,
  ModelCapability,
  ModelInfo,
  ModelRef,
  ModelRole,
  NotificationSeverity,
  NotificationSourceWorkbench,
  ProviderInfo,
  RoleAssignResult,
  RoleProfile,
  UsageState,
} from "../types";

type Emit = <T extends EventType>(
  aggregateType: EventAggregateType,
  aggregateId: string,
  eventType: T,
  payload: DomainEventPayload[T],
) => void;

type Notify = (
  severity: NotificationSeverity,
  message: string,
  sourceWorkbench: NotificationSourceWorkbench,
  sourceNodeId: string | null,
) => string;

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
 * 模型与用量模块（假数据层）：
 * Provider/模型/五角色配置与能力校验（PRD-MODEL-003/004）、
 * 凭据只新建替换不回显（PRD-MODEL-005）、用量与软阈值告警（PRD-USAGE-002/003）。
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

  private usage: UsageState = {
    soft_threshold_usd: 25,
    entries: [
      {
        id: "u-1",
        run_id: null,
        role: "qa",
        provider_id: "fake-chat",
        model_id: "fake-chat-pro",
        input_tokens: 42_300,
        output_tokens: 8_120,
        cache_tokens: 12_000,
        cost_usd: 3.42,
      },
      {
        id: "u-2",
        run_id: null,
        role: "planner",
        provider_id: "fake-large",
        model_id: "fake-large-a",
        input_tokens: 96_400,
        output_tokens: 11_800,
        cache_tokens: 40_200,
        cost_usd: 9.87,
      },
      {
        id: "u-3",
        run_id: null,
        role: "implementer",
        provider_id: "fake-large",
        model_id: "fake-large-a",
        input_tokens: 181_200,
        output_tokens: 33_400,
        cache_tokens: 61_900,
        cost_usd: 7.66,
      },
      {
        id: "u-4",
        run_id: null,
        role: "reviewer",
        provider_id: "fake-large",
        model_id: "fake-large-a",
        input_tokens: 58_900,
        output_tokens: 6_700,
        cache_tokens: 21_300,
        cost_usd: 0.9,
      },
      {
        id: "u-5",
        run_id: null,
        role: "clarifier",
        provider_id: "fake-chat",
        model_id: "fake-chat-mini",
        input_tokens: 12_400,
        output_tokens: 3_100,
        cache_tokens: null,
        cost_usd: null,
      },
    ],
  };

  private lastResult: RoleAssignResult = null;
  private thresholdAlerted = false;

  constructor(
    private readonly deps: {
      emit: Emit;
      notify: Notify;
      latency: () => Promise<void>;
    },
  ) {}

  private publish() {
    this.deps.emit("models", "registry", "models.updated", {
      providers: this.providers,
      roles: this.roles,
      usage: this.usage,
      last_result: this.lastResult,
    });
  }

  snapshotState() {
    return {
      providers: this.providers,
      roles: this.roles,
      usage: this.usage,
      last_result: this.lastResult,
    };
  }

  /** 首次访问时评估软阈值（80% 演示告警：GrayDango warning，PRD-USAGE-002） */
  evaluateThresholdOnce() {
    if (this.thresholdAlerted) return;
    this.thresholdAlerted = true;
    const alert = evaluateSoftThreshold(this.usage);
    if (alert) {
      this.deps.notify(
        "warning",
        `用量软阈值告警：累计 $${alert.total.toFixed(2)} 已达阈值 $${alert.threshold.toFixed(2)} 的 ${(alert.ratio * 100).toFixed(0)}%（软告警，不自动暂停或换模）。`,
        "models",
        null,
      );
    }
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

  setSoftThreshold(usd: number) {
    this.usage = { ...this.usage, soft_threshold_usd: usd };
    this.publish();
  }

  summaryLines(): string[] {
    const missing = this.roles.filter((profile) => !profile.primary).length;
    const alert = evaluateSoftThreshold(this.usage);
    return [
      `Provider ${this.providers.length} · 模型 ${this.providers.reduce((n, p) => n + p.models.length, 0)}`,
      missing > 0 ? `角色缺口 ${missing}` : "五角色已配置",
      alert ? `软告警：${(alert.ratio * 100).toFixed(0)}%` : "软告警：未触发",
    ];
  }
}
