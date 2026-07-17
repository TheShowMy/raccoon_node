import type { Edge } from "@xyflow/react";
import type {
  ModelRole,
  ProviderInfo,
  RoleAssignResult,
  RoleProfile,
  UsageState,
} from "../../api/types";
import type { SubFlowNode, SubProjection } from "../shared/SubCanvas";

/**
 * 模型与用量工作台投影（FE-MODEL-001/002、FE-USAGE-001，纯函数）：
 * Provider 节点 → 模型节点 → 角色节点 → 用量节点；保存结果单独成节点。
 */

export const modelsNodeId = {
  provider: (providerId: string) => `prov:${providerId}`,
  model: (providerId: string, modelId: string) =>
    `model:${providerId}/${modelId}`,
  roles: () => "model-roles",
  result: () => "model-result",
  usage: () => "model-usage",
};

export type ModelsProjectionInput = {
  providers: ProviderInfo[];
  roles: RoleProfile[];
  usage: UsageState | null;
  lastResult: RoleAssignResult;
  roleOrder: ModelRole[];
};

function node(
  id: string,
  type: string,
  x: number,
  y: number,
  data: Record<string, unknown> = {},
): SubFlowNode {
  return {
    id,
    type,
    position: { x, y },
    data,
    draggable: false,
    selectable: false,
    deletable: false,
  };
}

function edge(source: string, target: string): Edge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle: "out-r",
    targetHandle: "in-l",
    className: "de-chain",
    selectable: false,
    focusable: false,
  };
}

export function projectModels(input: ModelsProjectionInput): SubProjection {
  const nodes: SubFlowNode[] = [];
  const edges: Edge[] = [];

  input.providers.forEach((provider, pIndex) => {
    const providerId = modelsNodeId.provider(provider.id);
    nodes.push(node(providerId, "provider", 0, pIndex * 300, { provider }));
    provider.models.forEach((model, mIndex) => {
      const modelId = modelsNodeId.model(provider.id, model.id);
      nodes.push(
        node(modelId, "model", 380, pIndex * 300 + mIndex * 190, {
          model,
          providerLabel: provider.label,
        }),
      );
      edges.push(edge(providerId, modelId));
    });
  });

  nodes.push(
    node(modelsNodeId.roles(), "role_profiles", 780, 60, {
      roles: input.roles,
      providers: input.providers,
      roleOrder: input.roleOrder,
    }),
  );
  for (const provider of input.providers) {
    for (const model of provider.models) {
      edges.push(
        edge(modelsNodeId.model(provider.id, model.id), modelsNodeId.roles()),
      );
    }
  }

  if (input.lastResult) {
    nodes.push(
      node(modelsNodeId.result(), "model_result", 780, 560, {
        result: input.lastResult,
      }),
    );
    edges.push(edge(modelsNodeId.roles(), modelsNodeId.result()));
  }

  if (input.usage) {
    nodes.push(
      node(modelsNodeId.usage(), "usage", 1160, 60, { usage: input.usage }),
    );
    edges.push(edge(modelsNodeId.roles(), modelsNodeId.usage()));
  }

  return { nodes, edges };
}
