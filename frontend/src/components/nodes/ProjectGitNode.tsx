import { useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import {
  ChevronDown,
  ChevronRight,
  Download,
  GitBranch,
  GitCommit,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react";
import type {
  GitAction,
  GitChangeKind,
  GitDiffArea,
  GitFileStatus,
  GitStatus,
  StartNodeData,
} from "../../types/api";
import NodeBar from "../ui/NodeBar";

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
  const selectedInArea = useMemo(
    () =>
      files.filter((f) => data.selectedPaths.has(f.path)).map((f) => f.path),
    [files, data.selectedPaths],
  );
  const allPaths = useMemo(() => files.map((f) => f.path), [files]);
  const actionPaths = selectedInArea.length > 0 ? selectedInArea : allPaths;
  const disabled = data.busy || data.status?.write_blocked;

  const actionLabel =
    area === "unstaged"
      ? selectedInArea.length > 0
        ? "暂存所选"
        : "全部暂存"
      : selectedInArea.length > 0
        ? "取消所选"
        : "全部取消";

  const actionResult =
    area === "unstaged"
      ? selectedInArea.length > 0
        ? "已暂存所选文件"
        : "已暂存所有文件"
      : selectedInArea.length > 0
        ? "已取消暂存所选"
        : "已取消全部暂存";

  return (
    <section className="git-node__file-group">
      <div className="git-node__file-group-header">
        <span>
          {title} <em>{files.length}</em>
        </span>
        {files.length > 0 && (
          <Button
            label={actionLabel}
            size="sm"
            variant="ghost"
            className="git-node__file-group-action"
            isDisabled={disabled}
            onClick={() =>
              void data.onAction(
                area === "unstaged"
                  ? { type: "stage", paths: actionPaths }
                  : { type: "unstage", paths: actionPaths },
                actionResult,
              )
            }
          />
        )}
      </div>
      {files.length === 0 ? (
        <small>暂无文件</small>
      ) : (
        files.map((file) => {
          const kind = area === "staged" ? file.staged : file.unstaged;
          return (
            <div
              key={`${area}:${file.path}`}
              className={`git-node__file${
                data.selectedDiff?.path === file.path &&
                data.selectedDiff.area === area
                  ? " is-active"
                  : ""
              }`}
            >
              <CheckboxInput
                label={`选择 ${file.path}`}
                isLabelHidden
                size="sm"
                value={data.selectedPaths.has(file.path)}
                isDisabled={data.busy || data.status?.write_blocked}
                onChange={() => data.onTogglePath(file.path)}
              />
              <Button
                label={file.path}
                className="git-node__file-path"
                variant="ghost"
                size="sm"
                type="button"
                tooltip={file.path}
                onClick={() => void data.onSelectDiff(file.path, area)}
              >
                <span className={`git-node__change git-node__change--${kind}`}>
                  {kind ? CHANGE_LABEL[kind] : ""}
                </span>
                <span>{file.path}</span>
              </Button>
            </div>
          );
        })
      )}
    </section>
  );
}

function BranchSidebar({
  status,
  disabled,
  onAction,
  onPushRequest,
}: {
  status: GitStatus | null;
  disabled: boolean;
  onAction: (action: GitAction, result: string) => Promise<boolean>;
  onPushRequest: () => void;
}) {
  const [branchesOpen, setBranchesOpen] = useState(true);
  const [remotesOpen, setRemotesOpen] = useState(true);
  const [contextMenu, setContextMenu] = useState<{
    branch: string;
    x: number;
    y: number;
  } | null>(null);
  const [newBranchFrom, setNewBranchFrom] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const sidebarRef = useRef<HTMLDivElement>(null);
  const dirty = (status?.files.length ?? 0) > 0;

  function handleBranchContextMenu(e: React.MouseEvent, branch: string) {
    e.preventDefault();
    e.stopPropagation();
    const rect = sidebarRef.current?.getBoundingClientRect();
    if (!rect) return;
    setContextMenu({
      branch,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    setNewBranchFrom(null);
    setNewBranchName("");
  }

  function closeMenu() {
    setContextMenu(null);
    setNewBranchFrom(null);
    setNewBranchName("");
  }

  async function handleCreateBranch() {
    const branch = newBranchName.trim();
    if (!branch) return;
    if (await onAction({ type: "create_branch", branch }, `已创建 ${branch}`)) {
      closeMenu();
    }
  }

  return (
    <div className="git-node__branch-sidebar" ref={sidebarRef}>
      <div className="git-node__branch-ops">
        <IconButton
          label="Fetch"
          tooltip="Fetch"
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={12} />}
          isDisabled={disabled || !status?.remote_configured}
          onClick={() => void onAction({ type: "fetch" }, "远端状态已更新")}
        />
        <IconButton
          label="Pull"
          tooltip="Pull"
          size="sm"
          variant="ghost"
          icon={<Download size={12} />}
          isDisabled={disabled || dirty || !status?.remote_configured}
          onClick={() => void onAction({ type: "pull" }, "拉取完成")}
        />
        <IconButton
          label="Push"
          tooltip="Push"
          size="sm"
          variant="ghost"
          icon={<Upload size={12} />}
          isDisabled={disabled || !status?.remote_configured}
          onClick={onPushRequest}
        />
      </div>

      <div className="git-node__branch-section">
        <Button
          label="分支"
          variant="ghost"
          size="sm"
          type="button"
          className="git-node__branch-section-header"
          onClick={() => setBranchesOpen((v) => !v)}
        >
          {branchesOpen ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
          分支
        </Button>
        {branchesOpen && (
          <ul className="git-node__branch-list">
            {(status?.branches ?? []).map((branch) => (
              <li
                key={branch}
                className={`git-node__branch-item${
                  branch === status?.branch ? " is-current" : ""
                }`}
                onContextMenu={(e) =>
                  !disabled && handleBranchContextMenu(e, branch)
                }
                onClick={() => {
                  if (!disabled && branch !== status?.branch) {
                    void onAction(
                      { type: "switch_branch", branch },
                      `已切换到 ${branch}`,
                    );
                  }
                }}
              >
                {branch === status?.branch ? (
                  <GitBranch size={11} className="git-node__branch-icon" />
                ) : (
                  <span className="git-node__branch-indent" />
                )}
                <span>{branch}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {status?.remote_configured && status.upstream && (
        <div className="git-node__branch-section">
          <Button
            label="远程"
            variant="ghost"
            size="sm"
            type="button"
            className="git-node__branch-section-header"
            onClick={() => setRemotesOpen((v) => !v)}
          >
            {remotesOpen ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
            远端
          </Button>
          {remotesOpen && (
            <ul className="git-node__branch-list">
              <li className="git-node__branch-item">
                <span className="git-node__branch-indent" />
                <span>{status.upstream}</span>
                {(status.ahead > 0 || status.behind > 0) && (
                  <span className="git-node__branch-sync">
                    {status.ahead > 0 ? `↑${status.ahead}` : ""}
                    {status.behind > 0 ? ` ↓${status.behind}` : ""}
                  </span>
                )}
              </li>
            </ul>
          )}
        </div>
      )}

      {contextMenu && (
        <>
          <div className="git-node__context-overlay" onClick={closeMenu} />
          <div
            className="git-node__context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {contextMenu.branch !== status?.branch && (
              <Button
                label="切换到此分支"
                variant="ghost"
                size="sm"
                type="button"
                className="git-node__context-menu-item"
                onClick={() => {
                  void onAction(
                    { type: "switch_branch", branch: contextMenu.branch },
                    `已切换到 ${contextMenu.branch}`,
                  );
                  closeMenu();
                }}
              >
                切换到此分支
              </Button>
            )}
            {newBranchFrom === contextMenu.branch ? (
              <div className="git-node__new-branch-inline">
                <TextInput
                  hasAutoFocus
                  label="新分支名称"
                  isLabelHidden
                  width="100%"
                  placeholder="新分支名称"
                  value={newBranchName}
                  onChange={setNewBranchName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateBranch();
                    if (e.key === "Escape") closeMenu();
                  }}
                />
                <Button
                  label="创建"
                  size="sm"
                  variant="primary"
                  isDisabled={!newBranchName.trim()}
                  onClick={() => void handleCreateBranch()}
                />
              </div>
            ) : (
              <Button
                label="基于此新建分支"
                variant="ghost"
                size="sm"
                type="button"
                className="git-node__context-menu-item"
                onClick={() => setNewBranchFrom(contextMenu.branch)}
              >
                基于此新建分支…
              </Button>
            )}
            <Button
              label="取消"
              variant="ghost"
              size="sm"
              type="button"
              className="git-node__context-menu-item git-node__context-menu-item--close"
              onClick={closeMenu}
            >
              取消
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export default function ProjectGitNode({ data }: { data: GitData }) {
  const [commitMessage, setCommitMessage] = useState("");
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
      <NodeBar
        icon={<GitBranch size={16} />}
        accent="var(--accent-projects)"
        title={status?.branch ?? "Git"}
        subtitle={summary}
        expanded={false}
        onToggle={data.onToggleExpanded}
        extras={
          <>
            {data.error ? (
              <em className="git-node__collapsed-error" title={data.error}>
                !
              </em>
            ) : null}
            {data.busy ? <Loader2 size={14} className="spin-icon" /> : null}
          </>
        }
      />
    );
  }

  return (
    <section className="git-node">
      <NodeBar
        icon={<GitBranch size={16} />}
        accent="var(--accent-projects)"
        title={status?.branch ?? "Git 仓库"}
        subtitle={summary}
        expanded={true}
        onToggle={data.onToggleExpanded}
        actions={
          <IconButton
            label="刷新 Git 状态"
            tooltip="刷新 Git 状态"
            icon={
              <RefreshCw size={14} className={data.busy ? "spin-icon" : ""} />
            }
            size="sm"
            variant="ghost"
            isDisabled={data.busy}
            onClick={() => void data.onRefresh()}
          />
        }
      />

      {data.phase === "expanded" ? (
        <>
          <div className="git-node__workspace nodrag nowheel">
            <BranchSidebar
              status={status}
              disabled={disabled ?? false}
              onAction={data.onAction}
              onPushRequest={() => setConfirming("push")}
            />
            <div className="git-node__main-area">
              <div className="git-node__top-area">
                <aside className="git-node__files">
                  <FileGroup
                    title="未暂存"
                    area="unstaged"
                    files={unstaged}
                    data={data}
                  />
                  <FileGroup
                    title="已暂存"
                    area="staged"
                    files={staged}
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
                          <CodeBlock
                            code={data.diff.content || "没有可显示的文本差异"}
                            language="diff"
                            hasLineNumbers
                            maxHeight={360}
                            size="sm"
                            width="100%"
                          />
                        )}
                        {data.diff.truncated ? (
                          <small>差异内容已截断</small>
                        ) : null}
                      </>
                    ) : (
                      <p>选择文件查看差异</p>
                    )}
                  </div>
                </div>
              </div>
              <div className="git-node__commit">
                <TextArea
                  className="git-node__commit-message"
                  label="提交信息"
                  isLabelHidden
                  placeholder="输入提交信息…"
                  value={commitMessage}
                  isDisabled={disabled}
                  onChange={setCommitMessage}
                  rows={3}
                />
                <Button
                  label="提交"
                  icon={<GitCommit size={14} />}
                  variant="primary"
                  isDisabled={
                    disabled || staged.length === 0 || !commitMessage.trim()
                  }
                  onClick={() => setConfirming("commit")}
                />
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

      <Dialog
        isOpen={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        width={420}
        purpose="required"
      >
        <Stack className="git-node__confirm nodrag" gap={4}>
          <Stack gap={1}>
            <Text type="large" weight="semibold">
              {confirming === "commit" ? "确认提交" : "确认推送"}
            </Text>
            <Text type="supporting" wordBreak="break-word">
              {confirming === "commit"
                ? `向 ${status?.branch ?? "当前分支"} 提交 ${staged.length} 个文件：${commitMessage}`
                : `将 ${status?.branch ?? "当前分支"} 推送到 ${status?.upstream ?? "origin"}（领先 ${status?.ahead ?? 0}）`}
            </Text>
          </Stack>
          <Stack direction="horizontal" gap={2} justify="end">
            <Button
              label="取消"
              variant="secondary"
              onClick={() => setConfirming(null)}
            />
            <Button
              label="确认"
              variant="primary"
              onClick={() => void confirmAction()}
            />
          </Stack>
        </Stack>
      </Dialog>
    </section>
  );
}
