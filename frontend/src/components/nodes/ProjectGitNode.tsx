import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  GitBranch,
  GitCommit,
  Loader2,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react";
import type {
  GitChangeKind,
  GitDiffArea,
  GitFileStatus,
  StartNodeData,
} from "../../types/api";

type GitData = Extract<StartNodeData, { kind: "project-git" }>;

const CHANGE_LABEL: Record<GitChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type_changed: "T",
  untracked: "?",
  conflicted: "!",
};

function FileGroup({
  title,
  area,
  files,
  data,
}: {
  title: string;
  area: GitDiffArea;
  files: GitFileStatus[];
  data: GitData;
}) {
  return (
    <section className="git-node__file-group">
      <strong>
        {title} <span>{files.length}</span>
      </strong>
      {files.length === 0 ? (
        <small>暂无文件</small>
      ) : (
        files.map((file) => {
          const kind = area === "staged" ? file.staged : file.unstaged;
          return (
            <div
              key={`${area}:${file.path}`}
              className={`git-node__file ${
                data.selectedDiff?.path === file.path &&
                data.selectedDiff.area === area
                  ? "is-active"
                  : ""
              }`}
            >
              <input
                type="checkbox"
                aria-label={`选择 ${file.path}`}
                checked={data.selectedPaths.has(file.path)}
                disabled={data.busy || data.status?.write_blocked}
                onChange={() => data.onTogglePath(file.path)}
              />
              <button
                type="button"
                title={file.path}
                onClick={() => void data.onSelectDiff(file.path, area)}
              >
                <span className={`git-node__change git-node__change--${kind}`}>
                  {kind ? CHANGE_LABEL[kind] : ""}
                </span>
                <span>{file.path}</span>
              </button>
            </div>
          );
        })
      )}
    </section>
  );
}

export default function ProjectGitNode({ data }: { data: GitData }) {
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [confirming, setConfirming] = useState<"commit" | "push" | null>(null);
  const status = data.status;
  const staged = useMemo(
    () => status?.files.filter((file) => file.staged) ?? [],
    [status],
  );
  const unstaged = useMemo(
    () => status?.files.filter((file) => file.unstaged) ?? [],
    [status],
  );
  const selectedStaged = staged
    .filter((file) => data.selectedPaths.has(file.path))
    .map((file) => file.path);
  const selectedUnstaged = unstaged
    .filter((file) => data.selectedPaths.has(file.path))
    .map((file) => file.path);
  const dirty = (status?.files.length ?? 0) > 0;
  const disabled = data.busy || status?.write_blocked;
  const summary = status
    ? `${status.files.length} 个变更${
        status.ahead || status.behind
          ? ` · ↑${status.ahead} ↓${status.behind}`
          : ""
      }`
    : "正在读取仓库状态";

  async function confirmAction() {
    if (confirming === "commit") {
      const succeeded = await data.onAction(
        { type: "commit", message: commitMessage, confirmed: true },
        "提交完成",
      );
      if (succeeded) setCommitMessage("");
    } else if (confirming === "push") {
      await data.onAction({ type: "push", confirmed: true }, "推送完成");
    }
    setConfirming(null);
  }

  if (data.phase === "collapsed") {
    return (
      <button
        type="button"
        className="git-node__collapsed nodrag"
        aria-expanded="false"
        onClick={data.onToggleExpanded}
      >
        <GitBranch size={17} />
        <span>
          <strong>{status?.branch ?? "Git"}</strong>
          <small>{summary}</small>
        </span>
        {data.error ? <em title={data.error}>!</em> : null}
        {data.busy ? <Loader2 size={14} className="spin-icon" /> : null}
        <ChevronRight size={16} />
      </button>
    );
  }

  return (
    <section className="git-node">
      <header className="git-node__titlebar nodrag">
        <GitBranch size={17} />
        <strong>{status?.branch ?? "Git 仓库"}</strong>
        <span>{summary}</span>
        <button
          type="button"
          aria-label="刷新 Git 状态"
          disabled={data.busy}
          onClick={() => void data.onRefresh()}
        >
          <RefreshCw size={14} className={data.busy ? "spin-icon" : ""} />
        </button>
        <button
          type="button"
          aria-label="收起 Git 节点"
          onClick={data.onToggleExpanded}
        >
          <ChevronDown size={16} />
        </button>
      </header>

      {data.phase === "expanded" ? (
        <>
          <div className="git-node__toolbar nodrag">
            <select
              aria-label="切换分支"
              value={status?.branch ?? ""}
              disabled={disabled || dirty}
              onChange={(event) =>
                void data.onAction(
                  { type: "switch_branch", branch: event.target.value },
                  `已切换到 ${event.target.value}`,
                )
              }
            >
              {status?.branches.map((branch) => (
                <option key={branch}>{branch}</option>
              ))}
            </select>
            <input
              value={newBranch}
              aria-label="新分支名称"
              placeholder="新分支"
              disabled={disabled || dirty}
              onChange={(event) => setNewBranch(event.target.value)}
            />
            <button
              type="button"
              aria-label="创建分支"
              disabled={disabled || dirty || !newBranch.trim()}
              onClick={async () => {
                const branch = newBranch.trim();
                if (
                  await data.onAction(
                    { type: "create_branch", branch },
                    `已创建 ${branch}`,
                  )
                ) {
                  setNewBranch("");
                }
              }}
            >
              <Plus size={13} />
            </button>
            <span className="git-node__toolbar-spacer" />
            <button
              type="button"
              disabled={disabled || !status?.remote_configured}
              onClick={() =>
                void data.onAction({ type: "fetch" }, "远端状态已更新")
              }
            >
              <RefreshCw size={13} /> Fetch
            </button>
            <button
              type="button"
              disabled={disabled || dirty || !status?.remote_configured}
              onClick={() => void data.onAction({ type: "pull" }, "拉取完成")}
            >
              <Download size={13} /> Pull
            </button>
            <button
              type="button"
              disabled={disabled || !status?.remote_configured}
              onClick={() => setConfirming("push")}
            >
              <Upload size={13} /> Push
            </button>
          </div>

          <div className="git-node__workspace nodrag nowheel">
            <aside className="git-node__files">
              <div className="git-node__batch-actions">
                <button
                  type="button"
                  disabled={disabled || selectedUnstaged.length === 0}
                  onClick={() =>
                    void data.onAction(
                      { type: "stage", paths: selectedUnstaged },
                      "已暂存所选文件",
                    )
                  }
                >
                  暂存所选
                </button>
                <button
                  type="button"
                  disabled={disabled || selectedStaged.length === 0}
                  onClick={() =>
                    void data.onAction(
                      { type: "unstage", paths: selectedStaged },
                      "已取消暂存",
                    )
                  }
                >
                  取消暂存
                </button>
              </div>
              <FileGroup
                title="已暂存"
                area="staged"
                files={staged}
                data={data}
              />
              <FileGroup
                title="未暂存"
                area="unstaged"
                files={unstaged}
                data={data}
              />
            </aside>
            <div className="git-node__detail">
              <div className="git-node__diff">
                {data.diff ? (
                  <>
                    <div>
                      <strong>{data.diff.path}</strong>
                      <span>
                        {data.diff.area === "staged" ? "已暂存" : "未暂存"}
                      </span>
                    </div>
                    {data.diff.binary ? (
                      <p>二进制文件不提供差异预览</p>
                    ) : (
                      <pre>{data.diff.content || "没有可显示的文本差异"}</pre>
                    )}
                    {data.diff.truncated ? <small>差异内容已截断</small> : null}
                  </>
                ) : (
                  <p>选择文件查看差异</p>
                )}
              </div>
              <div className="git-node__commit">
                <textarea
                  aria-label="提交信息"
                  placeholder="输入提交信息…"
                  value={commitMessage}
                  disabled={disabled}
                  onChange={(event) => setCommitMessage(event.target.value)}
                />
                <button
                  type="button"
                  disabled={
                    disabled || staged.length === 0 || !commitMessage.trim()
                  }
                  onClick={() => setConfirming("commit")}
                >
                  <GitCommit size={14} />
                  提交
                </button>
              </div>
            </div>
          </div>

          <footer className="git-node__status">
            <span>
              {status?.write_blocked
                ? status.blocked_reason
                : data.error || data.lastResult || "Git 状态已就绪"}
            </span>
            <span>{status?.upstream ?? "未设置 upstream"}</span>
          </footer>
        </>
      ) : null}

      {confirming ? (
        <div
          className="git-node__confirm nodrag"
          role="dialog"
          aria-modal="true"
        >
          <div>
            <strong>{confirming === "commit" ? "确认提交" : "确认推送"}</strong>
            <p>
              {confirming === "commit"
                ? `向 ${status?.branch ?? "当前分支"} 提交 ${staged.length} 个文件：${commitMessage}`
                : `将 ${status?.branch ?? "当前分支"} 推送到 ${status?.upstream ?? "origin"}（领先 ${status?.ahead ?? 0}）`}
            </p>
            <span>
              <button type="button" onClick={() => setConfirming(null)}>
                取消
              </button>
              <button type="button" onClick={() => void confirmAction()}>
                确认
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
