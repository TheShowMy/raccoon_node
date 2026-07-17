import { useMemo } from "react";
import type { ModelRole } from "../../api/types";
import { useDomainStore } from "../../store/domainStore";
import { SubCanvas } from "../shared/SubCanvas";
import {
  ModelNode,
  ModelResultNode,
  ProviderNode,
  RoleProfilesNode,
  UsageNode,
} from "./nodes";
import { projectModels } from "./projection";

const nodeTypes = {
  provider: ProviderNode,
  model: ModelNode,
  role_profiles: RoleProfilesNode,
  model_result: ModelResultNode,
  usage: UsageNode,
};

const ROLE_ORDER: ModelRole[] = [
  "qa",
  "clarifier",
  "planner",
  "implementer",
  "reviewer",
];

/** 模型与用量工作台（FE-MODEL-*、FE-USAGE-*） */
export function ModelsWorkbench() {
  const providers = useDomainStore((state) => state.providers);
  const roles = useDomainStore((state) => state.roles);
  const usage = useDomainStore((state) => state.usage);
  const modelResult = useDomainStore((state) => state.modelResult);
  const projection = useMemo(
    () =>
      projectModels({
        providers,
        roles,
        usage,
        lastResult: modelResult,
        roleOrder: ROLE_ORDER,
      }),
    [providers, roles, usage, modelResult],
  );
  return (
    <SubCanvas
      kind="models"
      nodeTypes={nodeTypes}
      projection={projection}
      ariaLabel="模型与用量子画布"
    />
  );
}
