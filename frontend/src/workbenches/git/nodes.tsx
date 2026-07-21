import { PixelButton } from "@pxlkit/ui-kit";
import { useMutation } from "@tanstack/react-query";
import { memo, useEffect, useRef, useState } from "react";
import { getApi } from "../../api";
import { CHANGE_STATUS_LABELS, groupChanges } from "../../api/git";
import type {
  GitChange,
  GitMutationResult,
  GitRepoState,
  WorkbenchActionKind,
} from "../../api/types";
import { DiffView } from "../../components/DiffView";
import { useGitStore } from "../../store/gitStore";

function useRequestGit() {
  return useMutation({
    mutationFn: (input: {
      kind: WorkbenchActionKind;
      payload: Record<string, string>;
    }) =>
      getApi().requestWorkbenchAction({
        ...input,
        source_node_id: null,
      }),
  });
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
  const requestMutation = useRequestGit();
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
          disabled={locked || requestMutation.isPending}
          onClick={() =>
            requestMutation.mutate({ kind: "git_fetch", payload: {} })
          }
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
          disabled={
            locked || requestMutation.isPending || (current?.behind ?? 0) === 0
          }
          onClick={() =>
            requestMutation.mutate({ kind: "git_pull", payload: {} })
          }
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
          disabled={
            locked || requestMutation.isPending || (current?.ahead ?? 0) === 0
          }
          onClick={() =>
            requestMutation.mutate({ kind: "git_push", payload: {} })
          }
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
  const requestMutation = useRequestGit();
  return (
    <>
      <button type="button" className="git-nav-item" data-active>
        <span>▣ Local Changes</span>
        <strong>{git.changes.length}</strong>
      </button>
      <div className="git-nav-section">
        <h4 className="workbench-section-heading">Branches</h4>
        <ul className="git-branch-list" aria-label="分支列表">
          {git.branches.map((branch) => (
            <li key={branch.name} data-current={branch.current || undefined}>
              <button
                type="button"
                disabled={locked || requestMutation.isPending || branch.current}
                onClick={() =>
                  requestMutation.mutate({
                    kind: "git_switch_branch",
                    payload: { branch: branch.name },
                  })
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
          disabled={
            locked || requestMutation.isPending || !newBranchName.trim()
          }
          onClick={() =>
            requestMutation.mutate({
              kind: "git_create_branch",
              payload: { branch: newBranchName.trim() },
            })
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
  const selectedChangePath = useGitStore((state) => state.selectedChangePath);
  const checked = useGitStore((state) =>
    state.selectedChangePaths.includes(change.path),
  );
  const selectable = change.status !== "conflicted";
  const handleResult = (result: GitMutationResult) => {
    setError(result.ok ? null : result.message);
    if (result.ok) {
      useGitStore.getState().removeSelectedChanges(result.changed_paths);
    }
  };
  const stageMutation = useMutation({
    mutationFn: () => getApi().stageChanges([change.path]),
    onSuccess: handleResult,
  });
  const unstageMutation = useMutation({
    mutationFn: () => getApi().unstageChanges([change.path]),
    onSuccess: handleResult,
  });
  const requestMutation = useRequestGit();
  const mutationPending =
    stageMutation.isPending ||
    unstageMutation.isPending ||
    requestMutation.isPending;
  return (
    <li
      className="git-change-row"
      data-selected={selectedChangePath === change.path || undefined}
      data-checked={checked || undefined}
      data-action-source={`git_discard:${change.path}`}
      data-action-source-active={
        activeSourceKey === `git_discard:${change.path}` || undefined
      }
    >
      <div className="git-change-row__line">
        <label className="git-selection-control">
          <input
            type="checkbox"
            checked={checked}
            disabled={locked || !selectable}
            aria-label={
              selectable
                ? `选择 ${change.path}`
                : `${change.path} 存在冲突，不能批量暂存`
            }
            onChange={() =>
              useGitStore.getState().toggleChangeSelection(change.path)
            }
          />
          <span aria-hidden="true" />
        </label>
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
          {["unstaged", "untracked"].includes(change.status) ? (
            <button
              type="button"
              className="git-change-row__action"
              disabled={locked || mutationPending}
              aria-label={`暂存 ${change.path}`}
              onClick={() => stageMutation.mutate()}
            >
              暂存
            </button>
          ) : null}
          {change.status === "staged" ? (
            <button
              type="button"
              className="git-change-row__action"
              disabled={locked || mutationPending}
              aria-label={`取消暂存 ${change.path}`}
              onClick={() => unstageMutation.mutate()}
            >
              取消暂存
            </button>
          ) : null}
          {change.status !== "conflicted" ? (
            <button
              type="button"
              className="git-change-row__action git-change-row__action--danger"
              disabled={locked || mutationPending}
              aria-label={`丢弃 ${change.path}`}
              onClick={() =>
                requestMutation.mutate({
                  kind: "git_discard",
                  payload: { path: change.path },
                })
              }
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

function GroupSelection({
  label,
  paths,
  selectedPaths,
  locked,
}: {
  label: string;
  paths: string[];
  selectedPaths: string[];
  locked: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedCount = paths.filter((path) =>
    selectedPaths.includes(path),
  ).length;
  const checked = paths.length > 0 && selectedCount === paths.length;
  const mixed = selectedCount > 0 && !checked;
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className="git-group-selection">
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        disabled={locked || paths.length === 0}
        aria-label={`${checked ? "取消全选" : "全选"}${label}`}
        onChange={() =>
          useGitStore.getState().setGroupSelection(paths, !checked)
        }
      />
      <span aria-hidden="true" />
    </label>
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
  const selectedPaths = useGitStore((state) => state.selectedChangePaths);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const staged = git.changes.filter((change) => change.status === "staged");
  const selectedChanges = git.changes.filter((change) =>
    selectedPaths.includes(change.path),
  );
  const stageablePaths = selectedChanges
    .filter((change) => ["unstaged", "untracked"].includes(change.status))
    .map((change) => change.path);
  const unstageablePaths = selectedChanges
    .filter((change) => change.status === "staged")
    .map((change) => change.path);
  const handleBatchResult = (result: GitMutationResult) => {
    setBulkMessage(result.message);
    if (result.ok) {
      useGitStore.getState().removeSelectedChanges(result.changed_paths);
    }
  };
  const stageMutation = useMutation({
    mutationFn: (paths: string[]) => getApi().stageChanges(paths),
    onSuccess: handleBatchResult,
  });
  const unstageMutation = useMutation({
    mutationFn: (paths: string[]) => getApi().unstageChanges(paths),
    onSuccess: handleBatchResult,
  });
  const requestMutation = useRequestGit();
  const bulkBusy = stageMutation.isPending || unstageMutation.isPending;
  return (
    <div className="git-changes-layout">
      <div className="git-bulk-toolbar" aria-label="Git 批量操作">
        <strong>已选 {selectedPaths.length}</strong>
        <button
          type="button"
          disabled={locked || bulkBusy || stageablePaths.length === 0}
          title={locked ? "写锁占用，批量写操作不可用" : undefined}
          onClick={() => stageMutation.mutate(stageablePaths)}
        >
          暂存所选（{stageablePaths.length}）
        </button>
        <button
          type="button"
          disabled={locked || bulkBusy || unstageablePaths.length === 0}
          title={locked ? "写锁占用，批量写操作不可用" : undefined}
          onClick={() => unstageMutation.mutate(unstageablePaths)}
        >
          取消暂存（{unstageablePaths.length}）
        </button>
        <button
          type="button"
          disabled={selectedPaths.length === 0}
          onClick={() => useGitStore.getState().clearChangeSelection()}
        >
          清除选择
        </button>
        <span role="status" aria-live="polite">
          {locked ? "写锁占用" : bulkMessage}
        </span>
      </div>
      <div className="git-change-list" data-scroll-key="git-change-list">
        {groups.length === 0 ? (
          <p className="tool-empty-state">工作区干净。</p>
        ) : (
          groups.map((group) => (
            <section key={group.status} className="git-change-group">
              <h4 className="workbench-section-heading">
                <span>
                  {CHANGE_STATUS_LABELS[group.status]}（{group.changes.length}）
                </span>
                <GroupSelection
                  label={CHANGE_STATUS_LABELS[group.status]}
                  paths={group.changes
                    .filter((change) => change.status !== "conflicted")
                    .map((change) => change.path)}
                  selectedPaths={selectedPaths}
                  locked={locked}
                />
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
          disabled={
            locked ||
            requestMutation.isPending ||
            staged.length === 0 ||
            !message.trim()
          }
          onClick={() =>
            requestMutation.mutate({
              kind: "git_commit",
              payload: { message: message.trim() },
            })
          }
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
