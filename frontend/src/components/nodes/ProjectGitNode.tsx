import { useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import {
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
} from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import type { ContextMenuOption } from "@astryxdesign/core/ContextMenu";
import {
  ChevronDown,
  ChevronRight,
  Download,
  GitBranch,
  GitCommit,
  RefreshCw,
  Upload,
} from "lucide-react";
import type {
  GitAction,
  GitChangeKind,
  GitDiff,
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

function changeColor(
  kind: GitChangeKind | null,
):
  | "default"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "cyan"
  | "blue"
  | "purple"
  | "pink"
  | "gray" {
  switch (kind) {
    case "added":
    case "untracked":
      return "green";
    case "deleted":
    case "conflicted":
      return "red";
    case "modified":
      return "yellow";
    case "renamed":
      return "cyan";
    case "copied":
      return "blue";
    case "type_changed":
      return "purple";
    default:
      return "default";
  }
}

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
    <VStack as="section" width="100%" gap={0} paddingBlock={1}>
      <HStack
        align="center"
        justify="between"
        paddingInline={3}
        paddingBlock={1}
      >
        <Text type="label" size="2xs" color="secondary">
          {title} ({files.length})
        </Text>
        {files.length > 0 && (
          <Button
            label={actionLabel}
            size="sm"
            variant="ghost"
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
      </HStack>
      {files.length === 0 ? (
        <VStack paddingInline={3} paddingBlock={2}>
          <Text type="supporting" size="2xs" color="disabled">
            暂无文件
          </Text>
        </VStack>
      ) : (
        files.map((file) => {
          const kind = area === "staged" ? file.staged : file.unstaged;
          const isActive =
            data.selectedDiff?.path === file.path &&
            data.selectedDiff?.area === area;
          return (
            <Item
              key={`${area}:${file.path}`}
              as="div"
              density="compact"
              label={file.path}
              labelLines={1}
              isSelected={isActive}
              isDisabled={disabled}
              startContent={
                <HStack gap={1}>
                  <CheckboxInput
                    label={`选择 ${file.path}`}
                    isLabelHidden
                    size="sm"
                    value={data.selectedPaths.has(file.path)}
                    isDisabled={disabled}
                    onChange={() => data.onTogglePath(file.path)}
                  />
                  {kind ? (
                    <Token
                      label={CHANGE_LABEL[kind]}
                      size="sm"
                      color={changeColor(kind)}
                    />
                  ) : null}
                </HStack>
              }
              onClick={() => void data.onSelectDiff(file.path, area)}
            />
          );
        })
      )}
    </VStack>
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
  const [newBranchFrom, setNewBranchFrom] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const dirty = (status?.files.length ?? 0) > 0;

  async function handleCreateBranch() {
    const branch = newBranchName.trim();
    if (!branch) return;
    if (await onAction({ type: "create_branch", branch }, `已创建 ${branch}`)) {
      setNewBranchFrom(null);
      setNewBranchName("");
    }
  }

  function closeNewBranch() {
    setNewBranchFrom(null);
    setNewBranchName("");
  }

  const branchMenuItems = (branch: string): ContextMenuOption[] => {
    const items: ContextMenuOption[] = [];
    if (branch !== status?.branch) {
      items.push({
        label: "切换到此分支",
        onClick: () =>
          void onAction(
            { type: "switch_branch", branch },
            `已切换到 ${branch}`,
          ),
      });
    }
    items.push({
      label: "基于此新建分支…",
      onClick: () => {
        setNewBranchFrom(branch);
        setNewBranchName("");
      },
    });
    items.push({ type: "divider" });
    items.push({ label: "取消", onClick: () => {} });
    return items;
  };

  return (
    <VStack width={220} height="100%" isScrollable gap={0}>
      <Toolbar
        label="Git 分支操作"
        size="sm"
        variant="transparent"
        startContent={
          <>
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
          </>
        }
      />
      <Divider />

      <Section variant="transparent" padding={0}>
        <Button
          label="分支"
          variant="ghost"
          size="sm"
          type="button"
          icon={
            branchesOpen ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          }
          onClick={() => setBranchesOpen((v) => !v)}
        />
        {branchesOpen && (
          <VStack gap={0}>
            {(status?.branches ?? []).map((branch) => (
              <ContextMenu
                key={branch}
                label={`${branch} 操作`}
                size="sm"
                isDisabled={disabled}
                items={branchMenuItems(branch)}
              >
                <Item
                  as="div"
                  density="compact"
                  label={branch}
                  labelLines={1}
                  isSelected={branch === status?.branch}
                  isDisabled={disabled}
                  startContent={
                    branch === status?.branch ? <GitBranch size={11} /> : null
                  }
                  onClick={() => {
                    if (!disabled && branch !== status?.branch) {
                      void onAction(
                        { type: "switch_branch", branch },
                        `已切换到 ${branch}`,
                      );
                    }
                  }}
                />
              </ContextMenu>
            ))}
          </VStack>
        )}
      </Section>

      {status?.remote_configured && status.upstream && (
        <Section variant="transparent" padding={0}>
          <Button
            label="远程"
            variant="ghost"
            size="sm"
            type="button"
            icon={
              remotesOpen ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )
            }
            onClick={() => setRemotesOpen((v) => !v)}
          />
          {remotesOpen && (
            <List density="compact" listStyle="none">
              <ListItem
                label={status.upstream}
                endContent={
                  status.ahead > 0 || status.behind > 0 ? (
                    <Text
                      type="supporting"
                      size="4xs"
                      color="disabled"
                      hasTabularNumbers
                    >
                      {status.ahead > 0 ? `↑${status.ahead}` : ""}
                      {status.behind > 0 ? `↓${status.behind}` : ""}
                    </Text>
                  ) : null
                }
              />
            </List>
          )}
        </Section>
      )}

      <Dialog
        isOpen={newBranchFrom !== null}
        onOpenChange={(open) => {
          if (!open) closeNewBranch();
        }}
        width={360}
        purpose="form"
      >
        <VStack className="nodrag" gap={4} padding={4} width="100%">
          <Text type="large" weight="semibold">
            基于 {newBranchFrom} 新建分支
          </Text>
          <TextInput
            hasAutoFocus
            label="新分支名称"
            placeholder="新分支名称"
            value={newBranchName}
            onChange={setNewBranchName}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateBranch();
              if (e.key === "Escape") closeNewBranch();
            }}
          />
          <HStack justify="end" gap={2}>
            <Button label="取消" variant="secondary" onClick={closeNewBranch} />
            <Button
              label="创建"
              variant="primary"
              isDisabled={!newBranchName.trim()}
              onClick={() => void handleCreateBranch()}
            />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}

function DiffArea({ diff }: { diff: GitDiff | null }) {
  const header = diff ? (
    <LayoutHeader padding={0} hasDivider>
      <HStack
        justify="between"
        align="center"
        paddingInline={3}
        paddingBlock={2}
      >
        <Text type="supporting" size="sm" weight="semibold" maxLines={1}>
          {diff.path}
        </Text>
        <Text type="supporting" size="sm" color="secondary">
          {diff.area === "staged" ? "已暂存" : "未暂存"}
        </Text>
      </HStack>
    </LayoutHeader>
  ) : undefined;

  const content = (
    <LayoutContent padding={0} isScrollable>
      {diff ? (
        diff.binary ? (
          <VStack padding={4}>
            <Text type="supporting" size="sm" color="disabled">
              二进制文件不提供差异预览
            </Text>
          </VStack>
        ) : (
          <CodeBlock
            code={diff.content || "没有可显示的文本差异"}
            language="diff"
            hasLineNumbers
            maxHeight={360}
            size="sm"
            width="100%"
          />
        )
      ) : (
        <VStack padding={4}>
          <Text type="supporting" size="sm" color="disabled">
            选择文件查看差异
          </Text>
        </VStack>
      )}
    </LayoutContent>
  );

  const footer = diff?.truncated ? (
    <LayoutFooter padding={0}>
      <HStack justify="end" paddingInline={3} paddingBlock={1}>
        <Text type="supporting" size="4xs" color="accent">
          差异内容已截断
        </Text>
      </HStack>
    </LayoutFooter>
  ) : undefined;

  return (
    <Layout
      height="fill"
      padding={0}
      defaultHasDividers
      header={header}
      footer={footer}
    >
      {content}
    </Layout>
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
              <Token label="!" size="sm" color="red" description={data.error} />
            ) : null}
            {data.busy ? <Spinner size="sm" aria-label="刷新中" /> : null}
          </>
        }
      />
    );
  }

  return (
    <VStack width="100%" height="100%" gap={0}>
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
          <StackItem size="fill">
            <HStack
              width="100%"
              height="100%"
              gap={0}
              className="nodrag nowheel"
            >
              <BranchSidebar
                status={status}
                disabled={disabled ?? false}
                onAction={data.onAction}
                onPushRequest={() => setConfirming("push")}
              />
              <Divider orientation="vertical" />
              <VStack width="100%" height="100%" gap={0}>
                <StackItem size="fill">
                  <HStack width="100%" height="100%" gap={0}>
                    <VStack width={300} height="100%" isScrollable gap={0}>
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
                    </VStack>
                    <Divider orientation="vertical" />
                    <DiffArea diff={data.diff} />
                  </HStack>
                </StackItem>
                <Section dividers={["top"]} height={88} padding={2}>
                  <HStack width="100%" height="100%" align="center" gap={2}>
                    <StackItem size="fill">
                      <TextArea
                        label="提交信息"
                        isLabelHidden
                        placeholder="输入提交信息…"
                        value={commitMessage}
                        isDisabled={disabled}
                        onChange={setCommitMessage}
                        rows={3}
                      />
                    </StackItem>
                    <Button
                      label="提交"
                      icon={<GitCommit size={14} />}
                      variant="primary"
                      isDisabled={
                        disabled || staged.length === 0 || !commitMessage.trim()
                      }
                      onClick={() => setConfirming("commit")}
                    />
                  </HStack>
                </Section>
              </VStack>
            </HStack>
          </StackItem>

          <Section variant="muted" dividers={["top"]} height={32} padding={0}>
            <HStack
              width="100%"
              height="100%"
              align="center"
              justify="between"
              paddingInline={3}
            >
              <Text type="supporting" size="4xs" color="secondary" maxLines={1}>
                {status?.write_blocked
                  ? status.blocked_reason
                  : data.error || data.lastResult || "Git 状态已就绪"}
              </Text>
              <Text type="supporting" size="4xs" color="secondary" maxLines={1}>
                {status?.upstream ?? "未设置 upstream"}
              </Text>
            </HStack>
          </Section>
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
        <VStack className="nodrag" gap={4} width="100%">
          <VStack gap={1}>
            <Text type="large" weight="semibold">
              {confirming === "commit" ? "确认提交" : "确认推送"}
            </Text>
            <Text type="supporting" wordBreak="break-word">
              {confirming === "commit"
                ? `向 ${status?.branch ?? "当前分支"} 提交 ${staged.length} 个文件：${commitMessage}`
                : `将 ${status?.branch ?? "当前分支"} 推送到 ${status?.upstream ?? "origin"}（领先 ${status?.ahead ?? 0}）`}
            </Text>
          </VStack>
          <HStack gap={2} justify="end">
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
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}
