import { useEffect } from "react";
import { useDomainStore } from "../../store/domainStore";
import { useModelsStore } from "../../store/modelsStore";
import { WorkbenchTabs } from "../shared/ToolWorkbench";
import {
  ModelCapabilityContent,
  ProviderList,
  ProviderModelContent,
  RoleProfilesContent,
} from "./nodes";

/** 设置 / 模型分类中的连续三栏内容，不是独立外层工作台。 */
export function ModelSettingsContent() {
  const providers = useDomainStore((state) => state.providers);
  const roles = useDomainStore((state) => state.roles);
  const modelResult = useDomainStore((state) => state.modelResult);
  const selectedProviderId = useModelsStore(
    (state) => state.selectedProviderId,
  );
  const selectedModelId = useModelsStore((state) => state.selectedModelId);
  const compactPane = useModelsStore((state) => state.compactPane);
  const provider =
    providers.find((item) => item.id === selectedProviderId) ??
    providers[0] ??
    null;
  const model =
    provider?.models.find((item) => item.id === selectedModelId) ??
    provider?.models[0] ??
    null;

  useEffect(() => {
    if (provider && provider.id !== selectedProviderId) {
      useModelsStore.setState({ selectedProviderId: provider.id });
    }
  }, [provider, selectedProviderId]);
  useEffect(() => {
    if (model && model.id !== selectedModelId) {
      useModelsStore.setState({ selectedModelId: model.id });
    }
  }, [model, selectedModelId]);

  return (
    <div className="model-settings" aria-label="模型配置">
      <WorkbenchTabs
        className="model-settings__compact-tabs"
        ariaLabel="模型配置分区"
        tabs={[
          { id: "providers", label: "Provider" },
          { id: "models", label: "模型" },
          { id: "detail", label: "能力与角色" },
        ]}
        active={compactPane}
        onChange={(value) => useModelsStore.getState().setCompactPane(value)}
      />
      <section
        className="model-settings__column model-settings__providers"
        data-compact-active={compactPane === "providers" || undefined}
        data-scroll-key="settings:models:providers"
        aria-label="Provider 列表"
      >
        <div className="workbench-section-heading">
          <span>Provider</span>
          <em>{providers.length}</em>
        </div>
        <ProviderList providers={providers} />
      </section>
      <section
        className="model-settings__column model-settings__catalog"
        data-compact-active={compactPane === "models" || undefined}
        data-scroll-key="settings:models:catalog"
        aria-label="凭据与模型"
      >
        <ProviderModelContent provider={provider} />
      </section>
      <section
        className="model-settings__column model-settings__detail"
        data-compact-active={compactPane === "detail" || undefined}
        data-scroll-key="settings:models:roles"
        aria-label="模型能力与角色"
      >
        <ModelCapabilityContent model={model} />
        <div className="model-settings__roles">
          <div className="workbench-section-heading">
            <span>五种角色</span>
          </div>
          <RoleProfilesContent
            roles={roles}
            providers={providers}
            result={modelResult}
          />
        </div>
      </section>
    </div>
  );
}
