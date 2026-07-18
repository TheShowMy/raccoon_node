import { PixelButton } from "@pxlkit/ui-kit";
import { memo, useState } from "react";
import { CHANGE_STATUS_LABELS, groupChanges } from "../../api/git";
import type {
  GitChange,
  GitRepoState,
  WorkbenchActionKind,
} from "../../api/types";
import { DiffView } from "../../components/DiffView";
import { useDomainStore } from "../../store/domainStore";
import { useGitStore } from "../../store/gitStore";

function requestGit(
  kind: WorkbenchActionKind,
  payload: Record<string, string>,
) {
  void useDomainStore
    .getState()
    .requestWorkbenchAction({ kind, payload, source_node_id: null });
}

export const GitToolbarContent = memo(function GitToolbarContent({
  git,
  activeSourceKey,
}: {
  git: GitRepoState;
  activeSourceKey: string | null;
}) {
  const current = git.branches.find((branch) => branch.current);
  const locked = git.write_lock.locked;
  return (
    <>
      <div className="git-toolbar__identity">
        <strong className="px-font-mono">{git.root.split("/").at(-1)}</strong>
        <span className="git-toolbar__branch">⑂ {current?.name ?? "—"}</span>
        <span className="git-toolbar__tracking">
          ahead {current?.ahead ?? 0} / behind {current?.behind ?? 0}
        </span>
        <span className="git-toolbar__lock" data-locked={locked || undefined}>
          {locked ? "写锁占用" : "写锁空闲"}
        </span>
      </div>
      <div className="git-toolbar__actions">
        <PixelButton
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={() => requestGit("git_fetch", {})}
          data-action-source="git_fetch"
          data-action-source-active={
            activeSourceKey === "git_fetch" || undefined
          }
        >
          Fetch
        </PixelButton>
        <PixelButton
          size="sm"
          variant="outline"
          disabled={locked || (current?.behind ?? 0) === 0}
          onClick={() => requestGit("git_pull", {})}
          data-action-source="git_pull"
          data-action-source-active={
            activeSourceKey === "git_pull" || undefined
          }
        >
          Pull
        </PixelButton>
        <PixelButton
          size="sm"
          tone="cyan"
          variant="outline"
          disabled={locked || (current?.ahead ?? 0) === 0}
          onClick={() => requestGit("git_push", {})}
          data-action-source="git_push"
          data-action-source-active={
            activeSourceKey === "git_push" || undefined
          }
        >
          Push
        </PixelButton>
      </div>
    </>
  );
});

export const RepositoryContent = memo(function RepositoryContent({
  git,
  activeSourceKey,
}: {
  git: GitRepoState;
  activeSourceKey: string | null;
}) {
  const newBranchName = useGitStore((state) => state.newBranchName);
  const locked = git.write_lock.locked;
  return (
    <>
      <button type="button" className="git-nav-item" data-active>
        <span>▣ Local Changes</span>
        <strong>{git.changes.length}</strong>
      </button>
      <div className="git-nav-section">
        <h4 className="tool-section-title">Branches</h4>
        <ul className="git-branch-list" aria-label="分支列表">
          {git.branches.map((branch) => (
            <li key={branch.name} data-current={branch.current || undefined}>
              <button
                type="button"
                disabled={locked || branch.current}
                onClick={() =>
                  requestGit("git_switch_branch", { branch: branch.name })
                }
                data-action-source="git_switch_branch"
                data-action-source-active={
                  activeSourceKey === "git_switch_branch" || undefined
                }
              >
                <span>{branch.current ? "●" : "○"}</span>
                <span className="px-font-mono">{branch.name}</span>
                <small>
                  {branch.ahead}/{branch.behind}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="git-new-branch">
        <label htmlFor="git-new-branch">新分支</label>
        <input
          id="git-new-branch"
          className="dnode__input"
          placeholder="feat/new-branch"
          value={newBranchName}
          onChange={(event) =>
            useGitStore.getState().setNewBranchName(event.target.value)
          }
        />
        <PixelButton
          size="sm"
          tone="green"
          variant="outline"
          disabled={locked || !newBranchName.trim()}
          onClick={() =>
            requestGit("git_create_branch", { branch: newBranchName.trim() })
          }
          data-action-source="git_create_branch"
          data-action-source-active={
            activeSourceKey === "git_create_branch" || undefined
          }
        >
          创建并切换
        </PixelButton>
      </div>
      <div className="git-repo-meta">
        <span className="px-font-mono">{git.root}</span>
        {git.last_commit ? <span>最近提交：{git.last_commit}</span> : null}
      </div>
    </>
  );
});

function ChangeRow({
  change,
  locked,
  activeSourceKey,
}: {
  change: GitChange;
  locked: boolean;
  activeSourceKey: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const run = async (
    fn: () => Promise<{ ok: boolean; message: string | null }>,
  ) => {
    const result = await fn();
    setError(result.ok ? null : result.message);
  };
  return (
    <li
      className="git-change-row"
      data-selected={
        useGitStore.getState().selectedChangePath === change.path || undefined
      }
      data-action-source={`git_discard:${change.path}`}
      data-action-source-active={
        activeSourceKey === `git_discard:${change.path}` || undefined
      }
    >
      <div className="git-change-row__line">
        <span
          className="git-change-row__status"
          data-status={change.status}
          aria-hidden="true"
        >
          {change.status === "staged"
            ? "S"
            : change.status === "unstaged"
              ? "M"
              : change.status === "untracked"
                ? "?"
                : "!"}
        </span>
        <button
          type="button"
          className="git-change-row__path px-font-mono"
          aria-label={`查看 ${change.path} 的 Diff`}
          title={change.path}
          onClick={() => useGitStore.getState().selectChange(change.path)}
        >
          {change.path}
        </button>
        <span className="git-change-row__ops">
          {change.status === "unstaged" ? (
            <button
              type="button"
              className="git-change-row__action"
              disabled={locked}
              aria-label={`暂存 ${change.path}`}
              onClick={() =>
                void run(() =>
                  useDomainStore.getState().stageChange(change.path),
                )
              }
            >
              暂存
            </button>
          ) : null}
          {change.status === "staged" ? (
            <button
              type="button"
              className="git-change-row__action"
              disabled={locked}
              aria-label={`取消暂存 ${change.path}`}
              onClick={() =>
                void run(() =>
                  useDomainStore.getState().unstageChange(change.path),
                )
              }
            >
              取消暂存
            </button>
          ) : null}
          {change.status !== "conflicted" ? (
            <button
              type="button"
              className="git-change-row__action git-change-row__action--danger"
              disabled={locked}
              aria-label={`丢弃 ${change.path}`}
              onClick={() => requestGit("git_discard", { path: change.path })}
            >
              丢弃
            </button>
          ) : null}
        </span>
      </div>
      {error ? <p className="dnode__warning">{error}</p> : null}
    </li>
  );
}

export const ChangesContent = memo(function ChangesContent({
  git,
  activeSourceKey,
}: {
  git: GitRepoState;
  activeSourceKey: string | null;
}) {
  const groups = groupChanges(git.changes);
  const locked = git.write_lock.locked;
  const message = useGitStore((state) => state.commitMessage);
  const staged = git.changes.filter((change) => change.status === "staged");
  return (
    <div className="git-changes-layout">
      <div className="git-change-list" data-scroll-key="git-change-list">
        {groups.length === 0 ? (
          <p className="tool-empty-state">工作区干净。</p>
        ) : (
          groups.map((group) => (
            <section key={group.status} className="git-change-group">
              <h4 className="tool-section-title">
                {CHANGE_STATUS_LABELS[group.status]}（{group.changes.length}）
              </h4>
              <ul aria-label={`${group.label}变更`}>
                {group.changes.map((change) => (
                  <ChangeRow
                    key={change.path}
                    change={change}
                    locked={locked}
                    activeSourceKey={activeSourceKey}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <div
        className="git-commit-composer"
        data-action-source="git_commit"
        data-action-source-active={
          activeSourceKey === "git_commit" || undefined
        }
      >
        <label htmlFor="git-commit-message">
          提交消息 · 暂存 {staged.length}
        </label>
        <textarea
          id="git-commit-message"
          className="dnode__textarea"
          placeholder="feat: 描述本次变更"
          rows={3}
          value={message}
          onChange={(event) =>
            useGitStore.getState().setCommitMessage(event.target.value)
          }
        />
        <PixelButton
          size="sm"
          tone="green"
          disabled={locked || staged.length === 0 || !message.trim()}
          onClick={() => requestGit("git_commit", { message: message.trim() })}
        >
          提交（需确认）
        </PixelButton>
      </div>
    </div>
  );
});

export const GitDiffContent = memo(function GitDiffContent({
  change,
}: {
  change: GitChange | null;
}) {
  if (!change) {
    return <p className="tool-empty-state">选择一个变更查看 Diff。</p>;
  }
  return (
    <div className="git-diff-content">
      <div className="git-diff-content__path">
        <span className="px-font-mono">{change.path}</span>
        <span>{CHANGE_STATUS_LABELS[change.status]}</span>
      </div>
      {change.diff ? (
        <DiffView diff={change.diff} ariaLabel="Diff 内容" />
      ) : (
        <p className="tool-empty-state">未跟踪文件暂无 Diff，暂存后可见。</p>
      )}
    </div>
  );
});
