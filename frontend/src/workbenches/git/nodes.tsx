import { PixelButton } from "@pxlkit/ui-kit";
import type { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { CHANGE_STATUS_LABELS, groupChanges } from "../../api/git";
import type {
  GitChange,
  GitRepoState,
  WorkbenchActionKind,
} from "../../api/types";
import { DiffView } from "../../components/DiffView";
import { DNode } from "../../components/DNode";
import { useDomainStore } from "../../store/domainStore";
import { useGitStore } from "../../store/gitStore";
import { gitNodeId } from "./projection";

function requestGit(
  kind: WorkbenchActionKind,
  payload: Record<string, string>,
  source: string,
) {
  void useDomainStore
    .getState()
    .requestWorkbenchAction({ kind, payload, source_node_id: source });
}

/* ── 仓库节点（FE-GIT-001：分支、ahead/behind、写锁） ── */

export const RepoNode = memo(function RepoNode() {
  const git = useDomainStore((state) => state.git);
  if (!git) return null;
  const current = git.branches.find((branch) => branch.current);
  return (
    <DNode
      icon="git"
      label="仓库"
      chip={git.write_lock.locked ? "写锁占用" : "写锁空闲"}
      chipTone={git.write_lock.locked ? "red" : "green"}
      width={300}
      ariaLabel="Git 仓库"
    >
      <p className="dnode__text px-font-mono">{git.root}</p>
      <p className="dnode__text">
        当前分支：<strong>{current?.name}</strong>（ahead {current?.ahead ?? 0}{" "}
        / behind {current?.behind ?? 0}）
      </p>
      {git.write_lock.locked ? (
        <p className="dnode__warning">
          writer lease 由 Run {git.write_lock.owner_run_id} 持有，Git
          写操作暂不可用（409）。
        </p>
      ) : null}
      {git.last_commit ? (
        <p className="dnode__meta">最近提交：{git.last_commit}</p>
      ) : null}
    </DNode>
  );
});

/* ── 分支节点 ── */

export const BranchesNode = memo(function BranchesNode({ data }: NodeProps) {
  const { git } = data as { git: GitRepoState };
  const newBranchName = useGitStore((state) => state.newBranchName);
  const locked = git.write_lock.locked;
  return (
    <DNode
      icon="merge"
      label="分支"
      chip={`${git.branches.length} 个`}
      width={320}
      ariaLabel="分支列表"
      actions={
        <PixelButton
          size="sm"
          tone="green"
          variant="outline"
          disabled={locked || !newBranchName.trim()}
          onClick={() =>
            requestGit(
              "git_create_branch",
              { branch: newBranchName.trim() },
              gitNodeId.branches(),
            )
          }
        >
          创建并切换
        </PixelButton>
      }
    >
      <ul className="dnode__lines" aria-label="分支列表">
        {git.branches.map((branch) => (
          <li key={branch.name}>
            {branch.current ? "● " : "○ "}
            <span className="px-font-mono">{branch.name}</span>（ahead{" "}
            {branch.ahead} / behind {branch.behind}）{" "}
            {!branch.current ? (
              <PixelButton
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  requestGit(
                    "git_switch_branch",
                    { branch: branch.name },
                    gitNodeId.branches(),
                  )
                }
              >
                切换
              </PixelButton>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="dnode__inline-form nodrag nowheel">
        <input
          className="dnode__input"
          aria-label="新分支名"
          placeholder="feat/new-branch"
          value={newBranchName}
          onChange={(event) =>
            useGitStore.getState().setNewBranchName(event.target.value)
          }
        />
      </div>
      <p className="dnode__meta">切换与创建走确认节点（FE-GIT-003）。</p>
    </DNode>
  );
});

/* ── 变更节点（FE-GIT-002：staged/unstaged/untracked/conflicted 分组） ── */

function ChangeRow({ change, locked }: { change: GitChange; locked: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const run = async (
    fn: () => Promise<{ ok: boolean; message: string | null }>,
  ) => {
    const result = await fn();
    setError(result.ok ? null : result.message);
  };
  return (
    <li>
      <button
        type="button"
        className="gchange__path px-font-mono"
        aria-label={`查看 ${change.path} 的 Diff`}
        onClick={() => useGitStore.getState().selectChange(change.path)}
      >
        {change.path}
      </button>
      <span className="gchange__ops">
        {change.status === "unstaged" ? (
          <PixelButton
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() =>
              void run(() => useDomainStore.getState().stageChange(change.path))
            }
          >
            暂存
          </PixelButton>
        ) : null}
        {change.status === "staged" ? (
          <PixelButton
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() =>
              void run(() =>
                useDomainStore.getState().unstageChange(change.path),
              )
            }
          >
            取消暂存
          </PixelButton>
        ) : null}
        {change.status !== "conflicted" ? (
          <PixelButton
            size="sm"
            tone="red"
            variant="outline"
            disabled={locked}
            onClick={() =>
              requestGit(
                "git_discard",
                { path: change.path },
                gitNodeId.changes(),
              )
            }
          >
            丢弃
          </PixelButton>
        ) : null}
      </span>
      {error ? <p className="dnode__warning">{error}</p> : null}
    </li>
  );
}

export const ChangesNode = memo(function ChangesNode({ data }: NodeProps) {
  const { git } = data as { git: GitRepoState };
  const groups = groupChanges(git.changes);
  const locked = git.write_lock.locked;
  return (
    <DNode
      icon="diff"
      label="变更"
      chip={`${git.changes.length} 个`}
      chipTone={git.changes.length > 0 ? "yellow" : "green"}
      width={340}
      ariaLabel="工作区变更"
    >
      {groups.length === 0 ? (
        <p className="dnode__text">工作区干净。</p>
      ) : (
        groups.map((group) => (
          <section key={group.status}>
            <h5 className="gchange__group-title">
              {CHANGE_STATUS_LABELS[group.status]}（{group.changes.length}）
            </h5>
            <ul className="gchange__list" aria-label={`${group.label}变更`}>
              {group.changes.map((change) => (
                <ChangeRow key={change.path} change={change} locked={locked} />
              ))}
            </ul>
          </section>
        ))
      )}
      <p className="dnode__meta">点击路径查看 Diff；丢弃修改走确认节点。</p>
    </DNode>
  );
});

/* ── Diff 节点（复用共享 DiffView） ── */

export const GitDiffNode = memo(function GitDiffNode({ data }: NodeProps) {
  const { change } = data as { change: GitChange };
  return (
    <DNode
      icon="diff"
      label="Diff"
      chip={CHANGE_STATUS_LABELS[change.status]}
      width={420}
      ariaLabel={`${change.path} 的 Diff`}
    >
      <p className="dnode__meta px-font-mono">{change.path}</p>
      {change.diff ? (
        <DiffView diff={change.diff} ariaLabel="Diff 内容" />
      ) : (
        <p className="dnode__text">未跟踪文件暂无 diff（加入暂存后可见）。</p>
      )}
    </DNode>
  );
});

/* ── 提交节点 ── */

export const CommitNode = memo(function CommitNode({ data }: NodeProps) {
  const { git } = data as { git: GitRepoState };
  const message = useGitStore((state) => state.commitMessage);
  const staged = git.changes.filter((change) => change.status === "staged");
  const locked = git.write_lock.locked;
  return (
    <DNode
      icon="confirm"
      label="提交"
      chip={`暂存 ${staged.length}`}
      chipTone={staged.length > 0 ? "cyan" : "gray"}
      width={320}
      ariaLabel="创建提交"
      actions={
        <PixelButton
          size="sm"
          tone="green"
          disabled={locked || staged.length === 0 || !message.trim()}
          onClick={() =>
            requestGit(
              "git_commit",
              { message: message.trim() },
              gitNodeId.commit(),
            )
          }
        >
          提交（需确认）
        </PixelButton>
      }
    >
      <div className="dnode__inline-form nodrag nowheel">
        <textarea
          className="dnode__textarea"
          aria-label="提交消息"
          placeholder="feat: 描述本次变更"
          rows={3}
          value={message}
          onChange={(event) =>
            useGitStore.getState().setCommitMessage(event.target.value)
          }
        />
      </div>
      {staged.length === 0 ? (
        <p className="dnode__meta">先在变更节点暂存文件。</p>
      ) : (
        <p className="dnode__meta">
          提交消息为 confirmed 语义，执行走确认节点。
        </p>
      )}
    </DNode>
  );
});

/* ── 同步节点 ── */

export const SyncNode = memo(function SyncNode({ data }: NodeProps) {
  const { git } = data as { git: GitRepoState };
  const current = git.branches.find((branch) => branch.current);
  const locked = git.write_lock.locked;
  return (
    <DNode
      icon="publish"
      label="同步"
      chip={`ahead ${current?.ahead ?? 0} / behind ${current?.behind ?? 0}`}
      width={320}
      ariaLabel="远端同步"
      actions={
        <>
          <PixelButton
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => requestGit("git_fetch", {}, gitNodeId.sync())}
          >
            fetch
          </PixelButton>
          <PixelButton
            size="sm"
            variant="outline"
            disabled={locked || (current?.behind ?? 0) === 0}
            onClick={() => requestGit("git_pull", {}, gitNodeId.sync())}
          >
            pull
          </PixelButton>
          <PixelButton
            size="sm"
            tone="cyan"
            variant="outline"
            disabled={locked || (current?.ahead ?? 0) === 0}
            onClick={() => requestGit("git_push", {}, gitNodeId.sync())}
          >
            push
          </PixelButton>
        </>
      }
    >
      <p className="dnode__text">
        与 origin 同步；push / pull / fetch 均走确认节点。
      </p>
      <p className="dnode__meta">
        发布（PR/MR）由需求交付 Run 独占执行，不在此操作。
      </p>
    </DNode>
  );
});
