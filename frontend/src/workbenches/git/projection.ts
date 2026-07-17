import type { Edge } from "@xyflow/react";
import type { GitRepoState, WorkbenchAction } from "../../api/types";
import type { SubFlowNode, SubProjection } from "../shared/SubCanvas";

/**
 * Git 工作台投影（FE-GIT-001/002/003，纯函数）：
 * 仓库节点连接分支/变更/提交/同步节点；危险操作的确认节点连在来源节点之后。
 */

export const gitNodeId = {
  repo: () => "git-repo",
  branches: () => "git-branches",
  changes: () => "git-changes",
  commit: () => "git-commit",
  diff: () => "git-diff",
  sync: () => "git-sync",
  actionConfirmation: (actionId: string) => `git-action:${actionId}`,
  actionResult: (actionId: string) => `git-action-result:${actionId}`,
};

const POS = {
  repo: { x: 0, y: 120 },
  branches: { x: 360, y: 0 },
  sync: { x: 360, y: 360 },
  changes: { x: 740, y: 0 },
  commit: { x: 1120, y: 0 },
  diff: { x: 1120, y: 360 },
  actionBaseY: 680,
} as const;

export type GitProjectionInput = {
  git: GitRepoState | null;
  selectedChangePath: string | null;
  actions: WorkbenchAction[];
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

function edge(
  source: string,
  target: string,
  kind: "chain" | "blocked" = "chain",
): Edge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle: "out-r",
    targetHandle: "in-l",
    className: `de-${kind}`,
    selectable: false,
    focusable: false,
  };
}

export function projectGit(input: GitProjectionInput): SubProjection {
  const nodes: SubFlowNode[] = [];
  const edges: Edge[] = [];
  if (!input.git) return { nodes, edges };

  nodes.push(node(gitNodeId.repo(), "git_repo", POS.repo.x, POS.repo.y));
  nodes.push(
    node(gitNodeId.branches(), "git_branches", POS.branches.x, POS.branches.y, {
      git: input.git,
    }),
    node(gitNodeId.sync(), "git_sync", POS.sync.x, POS.sync.y, {
      git: input.git,
    }),
    node(gitNodeId.changes(), "git_changes", POS.changes.x, POS.changes.y, {
      git: input.git,
    }),
    node(gitNodeId.commit(), "git_commit", POS.commit.x, POS.commit.y, {
      git: input.git,
    }),
  );
  edges.push(
    edge(gitNodeId.repo(), gitNodeId.branches()),
    edge(gitNodeId.repo(), gitNodeId.sync()),
    edge(gitNodeId.repo(), gitNodeId.changes()),
    edge(gitNodeId.changes(), gitNodeId.commit()),
  );

  const selected = input.selectedChangePath
    ? input.git.changes.find(
        (change) => change.path === input.selectedChangePath,
      )
    : null;
  if (selected) {
    nodes.push(
      node(gitNodeId.diff(), "git_diff", POS.diff.x, POS.diff.y, {
        change: selected,
      }),
    );
    edges.push(edge(gitNodeId.changes(), gitNodeId.diff()));
  }

  /* 危险操作确认链（FE-GIT-003）：确认节点连接在来源节点之后 */
  const gitActions = input.actions
    .filter((action) => action.kind.startsWith("git_"))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-3); // 画布上只保留最近三条，其余留在事件日志
  gitActions.forEach((action, index) => {
    const sourceId = action.source_node_id ?? gitNodeId.changes();
    const x = 360 + index * 380;
    if (action.state === "awaiting") {
      const id = gitNodeId.actionConfirmation(action.id);
      nodes.push(
        node(id, "git_action_confirmation", x, POS.actionBaseY, { action }),
      );
      edges.push(edge(sourceId, id, "blocked"));
    } else if (action.result) {
      const id = gitNodeId.actionResult(action.id);
      nodes.push(node(id, "git_action_result", x, POS.actionBaseY, { action }));
      edges.push(edge(sourceId, id));
    }
  });

  return { nodes, edges };
}
