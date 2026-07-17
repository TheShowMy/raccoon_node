import { useMemo } from "react";
import { useDomainStore } from "../../store/domainStore";
import { useGitStore } from "../../store/gitStore";
import { SubCanvas } from "../shared/SubCanvas";
import {
  WorkbenchActionConfirmationNode,
  WorkbenchActionResultNode,
} from "../shared/actionNodes";
import {
  BranchesNode,
  ChangesNode,
  CommitNode,
  GitDiffNode,
  RepoNode,
  SyncNode,
} from "./nodes";
import { projectGit } from "./projection";

const nodeTypes = {
  git_repo: RepoNode,
  git_branches: BranchesNode,
  git_changes: ChangesNode,
  git_diff: GitDiffNode,
  git_commit: CommitNode,
  git_sync: SyncNode,
  git_action_confirmation: WorkbenchActionConfirmationNode,
  git_action_result: WorkbenchActionResultNode,
};

/** Git 工作台（FE-GIT-*）：仓库 / 分支 / 变更 / Diff / 提交 / 同步 + 确认链 */
export function GitWorkbench() {
  const git = useDomainStore((state) => state.git);
  const workbenchActions = useDomainStore((state) => state.workbenchActions);
  const selectedChangePath = useGitStore((state) => state.selectedChangePath);
  const projection = useMemo(
    () =>
      projectGit({
        git,
        selectedChangePath,
        actions: Object.values(workbenchActions),
      }),
    [git, workbenchActions, selectedChangePath],
  );
  return (
    <SubCanvas
      kind="git"
      nodeTypes={nodeTypes}
      projection={projection}
      ariaLabel="Git 子画布"
    />
  );
}
