import { PixelButton, PixelTextarea } from "@pxlkit/ui-kit";
import { memo, type KeyboardEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { detectIntent } from "../api/intent";
import type {
  ConversationNode,
  DetectedIntent,
  IntentMode,
} from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import { MAX_IMAGES, useComposerStore } from "../store/composerStore";
import { useDomainStore } from "../store/domainStore";
import { ancestorChain, CHAT_NODE_WIDTH, type BranchDisplayItem } from "./dag";

/* ── 共享小件 ── */

const STATE_LABELS: Record<ConversationNode["state"], string> = {
  streaming: "生成中",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  aborted: "已停止",
};

export function StateChip({ state }: { state: ConversationNode["state"] }) {
  return (
    <span className="chat-node__chip" data-state={state}>
      {STATE_LABELS[state]}
    </span>
  );
}

function NodeShell({
  label,
  state,
  children,
  actions,
  ariaLabel,
}: {
  label: string;
  state?: ConversationNode["state"];
  children: React.ReactNode;
  actions?: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <section
      className="chat-node px-cut px-shadowed-sm"
      style={{ width: CHAT_NODE_WIDTH }}
      aria-label={ariaLabel}
    >
      {/* 连线锚点：无 Handle 时 XYFlow 不绘制任何边 */}
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <header className="chat-node__header">
        <span className="px-font-pixel chat-node__label">{label}</span>
        {state ? <StateChip state={state} /> : null}
      </header>
      {children}
      {actions ? (
        <footer className="chat-node__actions">{actions}</footer>
      ) : null}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </section>
  );
}

function StopButton({ branchId }: { branchId: string }) {
  return (
    <PixelButton
      size="sm"
      tone="red"
      variant="outline"
      onClick={() => void useDomainStore.getState().abortResponse(branchId)}
    >
      停止
    </PixelButton>
  );
}

/* ── Composer（FE-CHAT-001/002/007） ── */

const INTENT_LABELS: Record<DetectedIntent, string> = {
  question: "问答",
  change: "开发需求",
  ambiguous: "不确定（按问答处理）",
};

const OVERRIDE_OPTIONS: { value: IntentMode; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "question", label: "问答" },
  { value: "change", label: "开发" },
];

export type ComposerNodeData = { branchId: string };

export const ComposerNode = memo(function ComposerNode({ data }: NodeProps) {
  const { branchId } = data as ComposerNodeData;
  const draft = useComposerStore((state) => state.drafts[branchId]);
  const text = draft?.text ?? "";
  const intentOverride = draft?.intentOverride ?? "auto";
  const fileRefs = draft?.file_refs ?? [];
  const images = draft?.images ?? [];
  const detected = detectIntent(text);
  const effectiveIntent: DetectedIntent =
    intentOverride === "auto" ? detected : intentOverride;

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void useDomainStore.getState().sendMessage({
      branch_id: branchId,
      text: trimmed,
      intent: intentOverride,
      file_refs: fileRefs,
      images,
    });
    useComposerStore.getState().clearDraft(branchId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      send();
    }
  };

  const addImagePlaceholder = () => {
    useComposerStore
      .getState()
      .addImage(branchId, `图片-${images.length + 1}.png`);
  };

  return (
    <section
      className="chat-node chat-node--composer px-cut px-shadowed-sm"
      style={{ width: CHAT_NODE_WIDTH }}
      aria-label="消息编辑器"
    >
      {/* 连线锚点：Composer 是链尾，只有入边 */}
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <header className="chat-node__header">
        <span className="px-font-pixel chat-node__label">输入</span>
        <span
          className="chat-node__intent"
          data-ambiguous={effectiveIntent === "ambiguous" || undefined}
        >
          意图：{INTENT_LABELS[effectiveIntent]}
          {intentOverride !== "auto" ? "（已覆盖）" : ""}
        </span>
      </header>
      {fileRefs.length > 0 || images.length > 0 ? (
        <ul className="chat-node__refs" aria-label="引用与附件">
          {fileRefs.map((ref) => (
            <li key={ref} className="chat-node__ref">
              <span className="px-font-mono">{ref}</span>
              <button
                type="button"
                aria-label={`移除引用 ${ref}`}
                onClick={() =>
                  useComposerStore.getState().removeFileRef(branchId, ref)
                }
              >
                ×
              </button>
            </li>
          ))}
          {images.map((image) => (
            <li key={image} className="chat-node__ref chat-node__ref--image">
              🖼 {image}
              <button
                type="button"
                aria-label={`移除附件 ${image}`}
                onClick={() =>
                  useComposerStore.getState().removeImage(branchId, image)
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="nodrag nowheel">
        <PixelTextarea
          aria-label="消息内容"
          placeholder="描述问题或需求，Cmd/Ctrl+Enter 发送"
          value={text}
          rows={3}
          onChange={(event) =>
            useComposerStore
              .getState()
              .setDraft(branchId, { text: event.target.value })
          }
          onKeyDown={onKeyDown}
        />
      </div>
      <footer className="chat-node__actions">
        <div
          className="chat-node__override"
          role="group"
          aria-label="意图覆盖（只影响当前提交）"
        >
          {OVERRIDE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="chat-node__override-option"
              data-active={intentOverride === option.value || undefined}
              onClick={() =>
                useComposerStore
                  .getState()
                  .setDraft(branchId, { intentOverride: option.value })
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="chat-node__attach"
          disabled={images.length >= MAX_IMAGES}
          aria-label="添加图片附件（占位，不渲染大图）"
          title="添加图片附件占位（最多 3 张）"
          onClick={addImagePlaceholder}
        >
          ＋图片
        </button>
        <PixelButton
          size="sm"
          tone="cyan"
          disabled={!text.trim()}
          onClick={send}
        >
          发送
        </PixelButton>
      </footer>
    </section>
  );
});

/* ── 业务节点 ── */

type ConversationNodeData = { node: ConversationNode; branchId: string };

const useBranchFrom = () => {
  const setActiveBranch = useCanvasStore(
    (state) => state.setActiveConversationBranch,
  );
  return async (nodeId: string) => {
    const branchId = await useDomainStore.getState().branchFromNode(nodeId);
    if (branchId) setActiveBranch(branchId);
  };
};

export const UserMessageNode = memo(function UserMessageNode({
  data,
}: NodeProps) {
  const { node } = data as ConversationNodeData;
  const branchFrom = useBranchFrom();
  return (
    <NodeShell
      label="你"
      ariaLabel={`用户消息：${node.content.slice(0, 40)}`}
      actions={
        <PixelButton
          size="sm"
          variant="ghost"
          onClick={() => void branchFrom(node.id)}
        >
          从这里分支
        </PixelButton>
      }
    >
      <p className="chat-node__content">{node.content}</p>
      {node.intent ? (
        <p className="chat-node__meta">
          意图判定：{INTENT_LABELS[node.intent]}
        </p>
      ) : null}
    </NodeShell>
  );
});

export const ProcessNode = memo(function ProcessNode({ data }: NodeProps) {
  const { node, branchId } = data as ConversationNodeData;
  const streaming = node.state === "streaming";
  return (
    <NodeShell
      label="过程"
      state={node.state}
      ariaLabel="过程节点"
      actions={streaming ? <StopButton branchId={branchId} /> : null}
    >
      {node.content ? (
        <p className="chat-node__content chat-node__content--scroll">
          {node.content}
        </p>
      ) : (
        <p className="chat-node__shell">等待首个增量…</p>
      )}
    </NodeShell>
  );
});

const TOOL_STATE_LABELS: Record<string, string> = {
  waiting: "等待",
  running: "运行",
  completed: "完成",
  failed: "失败",
};

export const ToolNode = memo(function ToolNode({ data }: NodeProps) {
  const { node, branchId } = data as ConversationNodeData;
  const tool = node.tool_activity;
  const running = node.state === "running";
  return (
    <NodeShell
      label="工具"
      state={node.state}
      ariaLabel={`工具节点：${tool?.name ?? ""}`}
      actions={running ? <StopButton branchId={branchId} /> : null}
    >
      <p className="chat-node__content">{tool?.purpose ?? ""}</p>
      <p className="chat-node__meta">
        <code className="px-font-mono">{tool?.name}</code> ·{" "}
        {tool ? TOOL_STATE_LABELS[tool.state] : ""}
        {tool?.duration_ms != null
          ? ` · ${(tool.duration_ms / 1000).toFixed(1)}s`
          : ""}
      </p>
      {tool?.summary ? (
        <p className="chat-node__summary">摘要：{tool.summary.slice(0, 120)}</p>
      ) : null}
    </NodeShell>
  );
});

export const AssistantAnswerNode = memo(function AssistantAnswerNode({
  data,
}: NodeProps) {
  const { node, branchId } = data as ConversationNodeData;
  const streaming = node.state === "streaming";
  // PRD-CHAT-003：从连续问答节点整理为需求，来源与证据自动关联
  const createRequirement = () => {
    const state = useDomainStore.getState();
    const nodeIds = ancestorChain(state.conversation, node.id)
      .filter(
        (entry) =>
          entry.kind === "user_message" || entry.kind === "assistant_answer",
      )
      .map((entry) => entry.id);
    void state.createRequirementFromChat({
      branch_id: branchId,
      node_ids: nodeIds,
    });
  };
  return (
    <NodeShell
      label="回答"
      state={node.state}
      ariaLabel="回答节点"
      actions={
        streaming ? (
          <StopButton branchId={branchId} />
        ) : node.state === "completed" ? (
          <PixelButton size="sm" variant="outline" onClick={createRequirement}>
            整理为需求
          </PixelButton>
        ) : null
      }
    >
      {node.content ? (
        <p className="chat-node__content chat-node__content--scroll">
          {node.content}
        </p>
      ) : (
        <p className="chat-node__shell">等待首个增量…</p>
      )}
    </NodeShell>
  );
});

export const ProcessGroupNode = memo(function ProcessGroupNode({
  data,
}: NodeProps) {
  const item = data as Extract<BranchDisplayItem, { type: "process_group" }>;
  const toggle = useCanvasStore((state) => state.toggleProcessGroup);
  const failed = item.members.some((member) => member.state === "failed");
  const toolCount = item.members.filter(
    (member) => member.kind === "tool",
  ).length;
  return (
    <NodeShell
      label="过程组"
      ariaLabel={`过程组：${item.members.length} 个节点`}
      actions={
        <PixelButton
          size="sm"
          variant="outline"
          onClick={() => toggle(item.id)}
        >
          {item.expanded ? "折叠" : `展开 ${item.members.length} 项`}
        </PixelButton>
      }
    >
      <p className="chat-node__content">
        {item.members.length} 个过程/工具节点（含 {toolCount} 个工具）
        {failed ? " · 含失败" : ""}
      </p>
    </NodeShell>
  );
});
