import { PixelButton } from "@pxlkit/ui-kit";
import { useMutation } from "@tanstack/react-query";
import { getApi } from "../../api";
import {
  CAPABILITY_LABELS,
  requiredCapabilities,
  ROLE_LABELS,
  SUPPORT_LABELS,
} from "../../api/modelCaps";
import type {
  CapabilityName,
  ModelInfo,
  ModelRef,
  ModelRole,
  ProviderInfo,
  RoleAssignResult,
  RoleProfile,
} from "../../api/types";
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

export function ProviderList({ providers }: { providers: ProviderInfo[] }) {
  const selectedProviderId = useModelsStore(
    (state) => state.selectedProviderId,
  );
  return (
    <ul className="model-master-list" aria-label="Provider 列表">
      {providers.map((provider) => (
        <li key={provider.id}>
          <button
            type="button"
            data-active={selectedProviderId === provider.id || undefined}
            onClick={() =>
              useModelsStore.getState().selectProvider(provider.id)
            }
          >
            <span>
              <strong>{provider.label}</strong>
              <small>{provider.models.length} 个模型</small>
            </span>
            <em data-state={provider.credential}>
              {CREDENTIAL_LABELS[provider.credential]}
            </em>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ProviderModelContent({
  provider,
}: {
  provider: ProviderInfo | null;
}) {
  const secret = useModelsStore(
    (state) => (provider ? state.credentialInputs[provider.id] : "") ?? "",
  );
  const selectedModelId = useModelsStore((state) => state.selectedModelId);
  const credentialMutation = useMutation({
    mutationFn: (input: { provider_id: string; secret: string }) =>
      getApi().setProviderCredential(input),
  });
  if (!provider) {
    return <div className="tool-empty-state">选择一个 Provider 查看模型。</div>;
  }
  return (
    <div className="model-provider-detail">
      <section
        className="model-credential"
        aria-label={`${provider.label} 凭据`}
      >
        <div className="workbench-section-heading">
          <span>凭据</span>
          <em>{CREDENTIAL_LABELS[provider.credential]}</em>
        </div>
        <p className="dnode__meta">
          鉴权字段：{provider.auth_fields.join("、")}；密钥只写系统密钥库。
        </p>
        <div className="dnode__inline-form nodrag nowheel">
          <input
            className="dnode__input"
            type="password"
            aria-label={`${provider.label} 凭据`}
            placeholder="只新建或替换，不回显"
            value={secret}
            onChange={(event) =>
              useModelsStore
                .getState()
                .setCredentialInput(provider.id, event.target.value)
            }
          />
          <PixelButton
            size="sm"
            tone="green"
            variant="outline"
            disabled={!secret.trim() || credentialMutation.isPending}
            onClick={() => {
              credentialMutation.mutate({
                provider_id: provider.id,
                secret,
              });
              useModelsStore.getState().clearCredentialInput(provider.id);
            }}
          >
            {provider.credential === "configured" ? "替换" : "保存"}
          </PixelButton>
        </div>
      </section>
      <section className="model-list-section" aria-label="模型列表">
        <div className="workbench-section-heading">
          <span>模型</span>
          <em>{provider.models.length}</em>
        </div>
        <ul className="model-master-list">
          {provider.models.map((model) => (
            <li key={model.id}>
              <button
                type="button"
                data-active={selectedModelId === model.id || undefined}
                onClick={() => useModelsStore.getState().selectModel(model.id)}
              >
                <span>
                  <strong>{model.label}</strong>
                  <small className="px-font-mono">{model.id}</small>
                </span>
                <em>{SUPPORT_LABELS[model.capabilities.tools]}</em>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function ModelCapabilityContent({ model }: { model: ModelInfo | null }) {
  if (!model) {
    return <p className="dnode__meta">选择模型后显示能力矩阵。</p>;
  }
  return (
    <section
      className="model-capabilities"
      aria-label={`${model.label} 能力矩阵`}
    >
      <div className="workbench-section-heading">
        <span>{model.label}</span>
        <em className="px-font-mono">{model.id}</em>
      </div>
      <ul className="caplist">
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
    </section>
  );
}

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
  const primary = draft?.primary ?? profile.primary;
  const fallback = draft?.fallback ?? profile.fallback;
  const required = requiredCapabilities(profile.role)
    .map((name) => CAPABILITY_LABELS[name])
    .join("、");
  const assignMutation = useMutation({
    mutationFn: (input: {
      slot: "primary" | "fallback";
      model: ModelRef | null;
    }) =>
      getApi().assignRoleModel({
        role: profile.role,
        ...input,
      }),
    onSuccess: () => useModelsStore.getState().clearDraft(profile.role),
  });

  const save = (slot: "primary" | "fallback", value: ModelRef | null) => {
    assignMutation.mutate({ slot, model: value });
  };

  return (
    <li className="role-row">
      <div className="role-row__head">
        <strong>{ROLE_LABELS[profile.role]}</strong>
        <em className="role-row__required">要求：{required}</em>
      </div>
      <label>
        主模型
        <select
          className="dnode__input"
          aria-label={`${ROLE_LABELS[profile.role]}主模型`}
          disabled={assignMutation.isPending}
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
          disabled={assignMutation.isPending}
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

export function RoleProfilesContent({
  roles,
  providers,
  result,
}: {
  roles: RoleProfile[];
  providers: ProviderInfo[];
  result: RoleAssignResult | null;
}) {
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
    <>
      {result ? (
        <div className="model-result-strip" role="status" data-ok={result.ok}>
          {result.message}
        </div>
      ) : null}
      <ul className="role-list nodrag nowheel" aria-label="五角色配置">
        {sorted.map((profile) => (
          <RoleRow key={profile.role} profile={profile} options={options} />
        ))}
      </ul>
    </>
  );
}
