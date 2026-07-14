import { useMemo, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, Layout, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { FileSearch, GitBranch, RefreshCw } from "lucide-react";
import type { GitAction, GitDiffArea, GitFileStatus } from "../../types/api";
import type { GitWorkbenchModel } from "../../types/viewModels";

type Confirmation =
  | { kind: "commit"; action: GitAction; description: string }
  | { kind: "push"; action: GitAction; description: string }
  | { kind: "pull"; action: GitAction; description: string }
  | { kind: "switch"; action: GitAction; description: string };

function togglePath(current: Set<string>, path: string) {
  const next = new Set(current);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

function ChangeList({
  title,
  area,
  files,
  selected,
  disabled,
  onToggle,
  onSelectDiff,
  onApply,
}: {
  title: string;
  area: GitDiffArea;
  files: GitFileStatus[];
  selected: Set<string>;
  disabled: boolean;
  onToggle: (path: string) => void;
  onSelectDiff: (path: string, area: GitDiffArea) => Promise<void>;
  onApply: (paths: string[]) => Promise<void>;
}) {
  const paths = selected.size ? [...selected] : files.map((file) => file.path);
  return (
    <VStack gap={1}>
      <Toolbar
        label={title}
        startContent={
          <Text weight="semibold">
            {title} ({files.length})
          </Text>
        }
        endContent={
          files.length ? (
            <Button
              label={area === "unstaged" ? "暂存" : "取消暂存"}
              size="sm"
              variant="ghost"
              isDisabled={disabled}
              onClick={() => void onApply(paths)}
            />
          ) : undefined
        }
      />
      {files.length ? (
        files.map((file) => (
          <HStack key={`${area}:${file.path}`} gap={2} align="center">
            <CheckboxInput
              label={`选择 ${file.path}`}
              isLabelHidden
              value={selected.has(file.path)}
              isDisabled={disabled}
              onChange={() => onToggle(file.path)}
            />
            <Button
              label={file.path}
              variant="ghost"
              isDisabled={disabled}
              onClick={() => void onSelectDiff(file.path, area)}
            />
            <Text type="supporting" color="secondary">
              {area === "staged" ? file.staged : file.unstaged}
            </Text>
          </HStack>
        ))
      ) : (
        <Text type="supporting" color="secondary">
          暂无文件
        </Text>
      )}
    </VStack>
  );
}

export default function GitWorkbench({ data }: { data: GitWorkbenchModel }) {
  const [stagedSelection, setStagedSelection] = useState<Set<string>>(
    new Set(),
  );
  const [unstagedSelection, setUnstagedSelection] = useState<Set<string>>(
    new Set(),
  );
  const [commitMessage, setCommitMessage] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const status = data.status;
  const staged = useMemo(
    () => status?.files.filter((file) => file.staged) ?? [],
    [status],
  );
  const unstaged = useMemo(
    () => status?.files.filter((file) => file.unstaged) ?? [],
    [status],
  );
  const disabled = Boolean(data.busy || status?.write_blocked);
  const apply = async (action: GitAction, result: string) => {
    await data.onAction(action, result);
  };
  const confirm = async () => {
    if (!confirmation) return;
    const result = {
      commit: "提交完成",
      push: "推送完成",
      pull: "拉取完成",
      switch: "分支切换完成",
    }[confirmation.kind];
    if (await data.onAction(confirmation.action, result)) {
      if (confirmation.kind === "commit") setCommitMessage("");
      setConfirmation(null);
    }
  };

  return (
    <Layout
      height="fill"
      start={
        <LayoutPanel width={320} padding={2} hasDivider isScrollable>
          <VStack gap={3}>
            <Toolbar
              label="仓库状态"
              startContent={
                <HStack gap={2} align="center">
                  <GitBranch size={15} />
                  <Text weight="semibold">{status?.branch ?? "Git 仓库"}</Text>
                </HStack>
              }
              endContent={
                <Button
                  label="刷新"
                  tooltip="刷新 Git 状态"
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  icon={<RefreshCw size={14} />}
                  isDisabled={data.busy}
                  onClick={() => void data.onRefresh()}
                />
              }
            />
            <HStack gap={1} wrap="wrap">
              <Button
                label="Fetch"
                size="sm"
                variant="secondary"
                isDisabled={disabled || !status?.remote_configured}
                onClick={() => void apply({ type: "fetch" }, "远端状态已更新")}
              />
              <Button
                label="Pull"
                size="sm"
                variant="secondary"
                isDisabled={disabled || !status?.remote_configured}
                onClick={() =>
                  setConfirmation({
                    kind: "pull",
                    action: { type: "pull" },
                    description: `从 ${status?.upstream ?? "origin"} 拉取并合并。`,
                  })
                }
              />
              <Button
                label="Push"
                size="sm"
                variant="secondary"
                isDisabled={disabled || !status?.remote_configured}
                onClick={() =>
                  setConfirmation({
                    kind: "push",
                    action: { type: "push", confirmed: true },
                    description: `推送当前分支（领先 ${status?.ahead ?? 0}）。`,
                  })
                }
              />
            </HStack>
            <VStack gap={1}>
              <Text type="supporting" color="secondary">
                切换分支
              </Text>
              {status?.branches.map((branch) => (
                <Button
                  key={branch}
                  label={branch}
                  variant={branch === status.branch ? "secondary" : "ghost"}
                  isDisabled={disabled || branch === status.branch}
                  onClick={() =>
                    setConfirmation({
                      kind: "switch",
                      action: { type: "switch_branch", branch },
                      description: `切换到 ${branch}。未提交修改可能阻止切换。`,
                    })
                  }
                />
              ))}
            </VStack>
            <ChangeList
              title="未暂存"
              area="unstaged"
              files={unstaged}
              selected={unstagedSelection}
              disabled={disabled}
              onToggle={(path) =>
                setUnstagedSelection((current) => togglePath(current, path))
              }
              onSelectDiff={data.onSelectDiff}
              onApply={async (paths) => {
                await apply({ type: "stage", paths }, "文件已暂存");
                setUnstagedSelection(new Set());
              }}
            />
            <ChangeList
              title="已暂存"
              area="staged"
              files={staged}
              selected={stagedSelection}
              disabled={disabled}
              onToggle={(path) =>
                setStagedSelection((current) => togglePath(current, path))
              }
              onSelectDiff={data.onSelectDiff}
              onApply={async (paths) => {
                await apply({ type: "unstage", paths }, "已取消暂存");
                setStagedSelection(new Set());
              }}
            />
          </VStack>
        </LayoutPanel>
      }
    >
      <div className="git-main-area">
        <div
          className="git-diff-area"
          style={{ overflow: data.diff ? "auto" : "hidden" }}
        >
          <VStack gap={3} height="100%">
            {status?.write_blocked ? (
              <Banner
                status="warning"
                title="Git 写操作已阻止"
                description={status.blocked_reason ?? undefined}
              />
            ) : null}
            {data.error ? (
              <Banner
                status="error"
                title="Git 操作失败"
                description={data.error}
              />
            ) : null}
            {data.lastResult ? (
              <Banner status="success" title={data.lastResult} />
            ) : null}
            {data.diff ? (
              data.diff.binary ? (
                <Center height="100%">
                  <EmptyState title="二进制文件不可预览" isCompact />
                </Center>
              ) : (
                <CodeBlock
                  code={data.diff.content || "没有可显示的文本差异"}
                  language="diff"
                  title={`${data.diff.path} · ${data.diff.area === "staged" ? "已暂存" : "未暂存"}`}
                  hasLineNumbers
                  width="100%"
                />
              )
            ) : (
              <Center height="100%">
                <EmptyState
                  title="选择文件查看差异"
                  description="在左侧列表中点击文件，即可预览该文件的 Git 差异。"
                  icon={<FileSearch size={32} aria-hidden="true" />}
                  isCompact
                />
              </Center>
            )}
          </VStack>
        </div>
        <div className="git-commit-area">
          <HStack gap={2} align="end" className="git-commit-message">
            <div style={{ flex: 1, minWidth: 0 }}>
              <TextArea
                label="提交信息"
                value={commitMessage}
                rows={2}
                isDisabled={disabled}
                onChange={setCommitMessage}
              />
            </div>
            <Button
              label="提交"
              isDisabled={disabled || !staged.length || !commitMessage.trim()}
              onClick={() =>
                setConfirmation({
                  kind: "commit",
                  action: {
                    type: "commit",
                    message: commitMessage.trim(),
                    confirmed: true,
                  },
                  description: `向 ${status?.branch ?? "当前分支"} 提交 ${staged.length} 个文件。`,
                })
              }
            />
          </HStack>
        </div>
      </div>
      <AlertDialog
        isOpen={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title={
          confirmation?.kind === "commit"
            ? "确认提交"
            : confirmation?.kind === "push"
              ? "确认推送"
              : confirmation?.kind === "pull"
                ? "确认拉取"
                : "确认切换分支"
        }
        description={confirmation?.description ?? "确认执行 Git 操作。"}
        actionLabel="确认"
        cancelLabel="取消"
        actionVariant="destructive"
        isActionLoading={data.busy}
        onAction={() => void confirm()}
      />
    </Layout>
  );
}
