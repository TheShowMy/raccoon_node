import { useEffect } from "react";
import { useDomainStore } from "../../store/domainStore";
import { useGitStore } from "../../store/gitStore";
import {
  ToolWorkbench,
  WorkbenchPane,
  WorkbenchTabs,
  WorkbenchToolbar,
} from "../shared/ToolWorkbench";
import {
  WorkbenchActionDock,
  workbenchActionSourceKey,
} from "../shared/actionPanels";
import {
  ChangesContent,
  GitDiffContent,
  GitToolbarContent,
  RepositoryContent,
} from "./nodes";

/** Git 工作台（FE-GIT-*）：桌面客户端式三栏连续页面。 */
export function GitWorkbench() {
  const git = useDomainStore((state) => state.git);
  const workbenchActions = useDomainStore((state) => state.workbenchActions);
  const selectedChangePath = useGitStore((state) => state.selectedChangePath);
  const compactPane = useGitStore((state) => state.compactPane);
  const reconcileChangeSelection = useGitStore(
    (state) => state.reconcileChangeSelection,
  );
  useEffect(() => {
    reconcileChangeSelection(git?.changes.map((change) => change.path) ?? []);
  }, [git, reconcileChangeSelection]);
  if (!git) {
    return (
      <p className="tool-empty-state" role="status">
        Git 数据加载中…
      </p>
    );
  }
  const selectedChange = selectedChangePath
    ? (git.changes.find((change) => change.path === selectedChangePath) ?? null)
    : null;
  const actions = Object.values(workbenchActions)
    .filter((action) => action.kind.startsWith("git_"))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const activeAction =
    actions.find((action) => action.state === "awaiting") ?? null;
  const activeSourceKey = activeAction
    ? workbenchActionSourceKey(activeAction)
    : null;

  return (
    <ToolWorkbench className="git-workbench" ariaLabel="Git 客户端工作区">
      <WorkbenchToolbar ariaLabel="Git 工具栏">
        <GitToolbarContent git={git} activeSourceKey={activeSourceKey} />
      </WorkbenchToolbar>
      <WorkbenchTabs
        className="git-workbench__compact-tabs"
        ariaLabel="Git 工作区分区"
        active={compactPane}
        onChange={(pane) => useGitStore.getState().setCompactPane(pane)}
        tabs={[
          { id: "repository", label: "仓库" },
          { id: "changes", label: "变更", badge: git.changes.length },
          { id: "diff", label: "Diff" },
        ]}
      />
      <div className="git-workbench__panes" data-compact-pane={compactPane}>
        <WorkbenchPane
          paneId="git-repository"
          icon="git"
          label="仓库"
          chip={`${git.branches.length} 分支`}
          ariaLabel="仓库与分支"
          className="git-workbench__repository"
        >
          <RepositoryContent git={git} activeSourceKey={activeSourceKey} />
        </WorkbenchPane>
        <WorkbenchPane
          paneId="git-changes"
          icon="diff"
          label="本地变更"
          chip={`${git.changes.length}`}
          chipTone={git.changes.length > 0 ? "yellow" : "green"}
          ariaLabel="本地变更与提交"
          className="git-workbench__changes"
        >
          <ChangesContent git={git} activeSourceKey={activeSourceKey} />
        </WorkbenchPane>
        <WorkbenchPane
          paneId="git-diff"
          icon="diff"
          label="Diff"
          chip={selectedChange?.status ?? "未选择"}
          ariaLabel="变更 Diff"
          className="git-workbench__diff"
        >
          <GitDiffContent change={selectedChange} />
        </WorkbenchPane>
      </div>
      <WorkbenchActionDock actions={actions} />
    </ToolWorkbench>
  );
}
