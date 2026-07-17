import { PixelButton } from "@pxlkit/ui-kit";
import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import {
  CAPABILITY_LABELS,
  requiredCapabilities,
  ROLE_LABELS,
  SUPPORT_LABELS,
} from "../../api/modelCaps";
import {
  evaluateSoftThreshold,
  formatCost,
  formatTokens,
  totalCost,
  usageEntryComplete,
} from "../../api/usage";
import type {
  CapabilityName,
  ModelInfo,
  ModelRef,
  ModelRole,
  ProviderInfo,
  RoleAssignResult,
  RoleProfile,
  UsageState,
} from "../../api/types";
import { DNode } from "../../components/DNode";
import { useDomainStore } from "../../store/domainStore";
import { useModelsStore } from "../../store/modelsStore";

const CAPABILITY_ORDER: CapabilityName[] = [
  "text",
  "image",
  "streaming",
  "tools",
  "structured_output",
  "long_context",
];

const CREDENTIAL_LABELS: Record<ProviderInfo["credential"], string> = {
  configured: "已配置",
  missing: "未配置",
  invalid: "无效",
};

/* ── Provider 节点（FE-MODEL-001：鉴权字段由 Registry 描述；凭据不回显） ── */

export const ProviderNode = memo(function ProviderNode({ data }: NodeProps) {
  const { provider } = data as { provider: ProviderInfo };
  const secret = useModelsStore(
    (state) => state.credentialInputs[provider.id] ?? "",
  );
  return (
    <DNode
      icon="models"
      label={provider.label}
      chip={CREDENTIAL_LABELS[provider.credential]}
      chipTone={
        provider.credential === "configured"
          ? "green"
          : provider.credential === "invalid"
            ? "red"
            : "yellow"
      }
      width={320}
      ariaLabel={`Provider ${provider.label}`}
      actions={
        <PixelButton
          size="sm"
          tone="green"
          variant="outline"
          disabled={!secret.trim()}
          onClick={() => {
            void useDomainStore.getState().setProviderCredential({
              provider_id: provider.id,
              secret,
            });
            useModelsStore.getState().clearCredentialInput(provider.id);
          }}
        >
          {provider.credential === "configured" ? "替换凭据" : "保存凭据"}
        </PixelButton>
      }
    >
      <p className="dnode__meta">鉴权字段：{provider.auth_fields.join("、")}</p>
      <div className="dnode__inline-form nodrag nowheel">
        <input
          className="dnode__input"
          type="password"
          aria-label={`${provider.label} 凭据`}
          placeholder="只新建/替换，不回显"
          value={secret}
          onChange={(event) =>
            useModelsStore
              .getState()
              .setCredentialInput(provider.id, event.target.value)
          }
        />
      </div>
      <p className="dnode__meta">凭据保存在系统密钥库，状态文件只保存引用。</p>
    </DNode>
  );
});

/* ── 模型节点（能力矩阵） ── */

export const ModelNode = memo(function ModelNode({ data }: NodeProps) {
  const { model, providerLabel } = data as {
    model: ModelInfo;
    providerLabel: string;
  };
  return (
    <DNode
      icon="models"
      label={model.label}
      chip={providerLabel}
      width={340}
      ariaLabel={`模型 ${model.label}`}
    >
      <ul className="caplist" aria-label="能力矩阵">
        {CAPABILITY_ORDER.map((name) => {
          const support = model.capabilities[name];
          return (
            <li key={name} data-support={support}>
              <span>{CAPABILITY_LABELS[name]}</span>
              <em>{SUPPORT_LABELS[support]}</em>
            </li>
          );
        })}
      </ul>
    </DNode>
  );
});

/* ── 角色节点（五角色 primary + fallback；能力不匹配保存被阻止） ── */

const ALL_ROLES: ModelRole[] = [
  "qa",
  "clarifier",
  "planner",
  "implementer",
  "reviewer",
];

function modelOptions(
  providers: ProviderInfo[],
): { ref: ModelRef; label: string }[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      ref: `${provider.id}/${model.id}`,
      label: `${provider.label} · ${model.label}`,
    })),
  );
}

function RoleRow({
  profile,
  options,
}: {
  profile: RoleProfile;
  options: { ref: ModelRef; label: string }[];
}) {
  const draft = useModelsStore((state) => state.drafts[profile.role]);
  const primary =
    draft?.primary !== undefined ? draft.primary : profile.primary;
  const fallback =
    draft?.fallback !== undefined ? draft.fallback : profile.fallback;
  const dirty =
    (draft?.primary !== undefined && draft.primary !== profile.primary) ||
    (draft?.fallback !== undefined && draft.fallback !== profile.fallback);
  const required = requiredCapabilities(profile.role)
    .map((name) => CAPABILITY_LABELS[name])
    .join("、");

  const save = async (slot: "primary" | "fallback", value: ModelRef | null) => {
    await useDomainStore.getState().assignRoleModel({
      role: profile.role,
      slot,
      model: value,
    });
    useModelsStore.getState().clearDraft(profile.role);
  };

  return (
    <li className="role-row" data-dirty={dirty || undefined}>
      <div className="role-row__head">
        <strong>{ROLE_LABELS[profile.role]}</strong>
        <em className="role-row__required">要求：{required}</em>
      </div>
      <label>
        主模型
        <select
          className="dnode__input"
          aria-label={`${ROLE_LABELS[profile.role]}主模型`}
          value={primary ?? ""}
          onChange={(event) => {
            const value = event.target.value || null;
            useModelsStore
              .getState()
              .setDraft(profile.role, { primary: value });
            void save("primary", value);
          }}
        >
          <option value="">（未配置）</option>
          {options.map((option) => (
            <option key={option.ref} value={option.ref}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        回退
        <select
          className="dnode__input"
          aria-label={`${ROLE_LABELS[profile.role]}回退模型`}
          value={fallback ?? ""}
          onChange={(event) => {
            const value = event.target.value || null;
            useModelsStore
              .getState()
              .setDraft(profile.role, { fallback: value });
            void save("fallback", value);
          }}
        >
          <option value="">（无）</option>
          {options.map((option) => (
            <option key={option.ref} value={option.ref}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </li>
  );
}

export const RoleProfilesNode = memo(function RoleProfilesNode({
  data,
}: NodeProps) {
  const { roles, providers } = data as {
    roles: RoleProfile[];
    providers: ProviderInfo[];
    roleOrder: ModelRole[];
  };
  const options = modelOptions(providers);
  const sorted = ALL_ROLES.map(
    (role) =>
      roles.find((profile) => profile.role === role) ?? {
        role,
        primary: null,
        fallback: null,
      },
  );
  return (
    <DNode
      icon="models"
      label="模型角色"
      chip="5 角色"
      width={360}
      ariaLabel="模型角色配置"
    >
      <ul className="role-list nodrag nowheel" aria-label="五角色配置">
        {sorted.map((profile) => (
          <RoleRow key={profile.role} profile={profile} options={options} />
        ))}
      </ul>
      <p className="dnode__meta">
        保存即校验能力；不匹配时保存被阻止并生成结果节点（FE-MODEL-002）。
      </p>
    </DNode>
  );
});

/* ── 保存结果节点 ── */

export const ModelResultNode = memo(function ModelResultNode({
  data,
}: NodeProps) {
  const { result } = data as { result: NonNullable<RoleAssignResult> };
  return (
    <DNode
      icon="result"
      label="保存结果"
      chip={result.ok ? "成功" : "已阻止"}
      chipTone={result.ok ? "green" : "red"}
      width={360}
      ariaLabel="角色保存结果"
      className={result.ok ? undefined : "dnode--danger"}
    >
      <p className="dnode__text">{result.message}</p>
    </DNode>
  );
});

/* ── 用量节点（FE-USAGE-001：token/费用/完整性与软阈值） ── */

export const UsageNode = memo(function UsageNode({ data }: NodeProps) {
  const { usage } = data as { usage: UsageState };
  const total = totalCost(usage);
  const alert = evaluateSoftThreshold(usage);
  const ratio =
    total !== null && usage.soft_threshold_usd > 0
      ? Math.min(1, total / usage.soft_threshold_usd)
      : null;
  return (
    <DNode
      icon="validation"
      label="用量"
      chip={alert ? `软告警 ${(alert.ratio * 100).toFixed(0)}%` : "正常"}
      chipTone={alert ? "yellow" : "green"}
      width={460}
      ariaLabel="模型用量与费用"
    >
      <table className="usage-table nodrag nowheel" aria-label="用量明细">
        <thead>
          <tr>
            <th>角色</th>
            <th>模型</th>
            <th>输入</th>
            <th>输出</th>
            <th>缓存</th>
            <th>费用</th>
          </tr>
        </thead>
        <tbody>
          {usage.entries.map((entry) => (
            <tr
              key={entry.id}
              data-incomplete={!usageEntryComplete(entry) || undefined}
            >
              <td>{ROLE_LABELS[entry.role]}</td>
              <td className="px-font-mono">{entry.model_id}</td>
              <td>{formatTokens(entry.input_tokens)}</td>
              <td>{formatTokens(entry.output_tokens)}</td>
              <td>{formatTokens(entry.cache_tokens)}</td>
              <td>{formatCost(entry.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dnode__meta">
        合计：
        {total === null
          ? "不完整（存在未知价格，不估造）"
          : `$${total.toFixed(2)}`}{" "}
        · 软阈值 ${usage.soft_threshold_usd.toFixed(2)}
      </p>
      {ratio !== null ? (
        <div
          className="usage-meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          aria-label="软阈值使用率"
        >
          <span
            style={{ width: `${ratio * 100}%` }}
            data-alert={alert ? true : undefined}
          />
        </div>
      ) : null}
      {alert ? (
        <p className="dnode__warning">
          已达软阈值 {(alert.ratio * 100).toFixed(0)}
          %：仅告警，不自动暂停、取消或换模。
        </p>
      ) : null}
    </DNode>
  );
});
