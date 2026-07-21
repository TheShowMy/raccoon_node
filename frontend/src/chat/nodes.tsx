import { PixelButton, PixelTextarea } from "@pxlkit/ui-kit";
import { useMutation, useQuery } from "@tanstack/react-query";
import { memo, useCallback, useRef, useState, type KeyboardEvent } from "react";
import { getApi } from "../api";
import { detectIntent } from "../api/intent";
import type {
  ConversationNode,
  DetectedIntent,
  IntentMode,
} from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import {
  MAX_IMAGES,
  composerScopeKey,
  useComposerStore,
} from "../store/composerStore";
import { selectActiveConversation, useDomainStore } from "../store/domainStore";
import { ancestorChain, type BranchDisplayItem } from "./dag";

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
  statusLabel,
  statusState,
  children,
  actions,
  ariaLabel,
  selected = false,
}: {
  label: string;
  state?: ConversationNode["state"];
  statusLabel?: string;
  statusState?: ConversationNode["state"];
  children: React.ReactNode;
  actions?: React.ReactNode;
  ariaLabel: string;
  selected?: boolean;
}) {
  return (
    <section
      className="chat-node px-cut px-shadowed-sm"
      aria-label={ariaLabel}
      data-selected={selected || undefined}
    >
      <header className="chat-node__header">
        <span className="px-font-pixel chat-node__label">{label}</span>
        {statusLabel ? (
          <span
            className="chat-node__chip"
            data-state={statusState ?? state ?? "completed"}
          >
            {statusLabel}
          </span>
        ) : state ? (
          <StateChip state={state} />
        ) : null}
      </header>
      {children}
      {actions ? (
        <footer className="chat-node__actions">{actions}</footer>
      ) : null}
    </section>
  );
}

function RedactedContent() {
  return (
    <p className="chat-node__redacted" role="status">
      已删除
    </p>
  );
}

function requestConversationFollow() {
  useCanvasStore.getState().requestConversationFollow();
}

/* 输入框自动聚焦：每个逻辑输入节点只聚焦一次。
   对话列表做窗口化渲染（FE-CHAT-023），节点随滚动反复卸载重挂载，
   裸 autoFocus 会在每次重挂载时抢焦点；用 key 守卫区分
   「新输入节点出现」（聚焦）与「滚动重挂载」（跳过）。
   preventScroll 保持滚动位置，不与跟随/滚动恢复（FE-CANVAS-022）冲突。 */
const autofocusedKeys = new Set<string>();

function autofocusOnce(key: string) {
  return (el: HTMLTextAreaElement | null) => {
    if (!el || autofocusedKeys.has(key)) return;
    autofocusedKeys.add(key);
    el.focus({ preventScroll: true });
  };
}

function CancelRequirementButton({
  requirementId,
}: {
  requirementId: string | null;
}) {
  const cancelMutation = useMutation({
    mutationFn: (id: string) => getApi().cancelRequirement(id),
  });
  if (!requirementId) return null;
  return (
    <PixelButton
      size="sm"
      tone="red"
      variant="ghost"
      disabled={cancelMutation.isPending}
      onClick={() => {
        requestConversationFollow();
        cancelMutation.mutate(requirementId);
      }}
    >
      {cancelMutation.isPending ? "取消中" : "取消本次需求"}
    </PixelButton>
  );
}

function StopButton({
  sessionId,
  branchId,
}: {
  sessionId: string;
  branchId: string;
}) {
  const abortMutation = useMutation({
    mutationFn: () => getApi().abortResponse(sessionId, branchId),
  });
  return (
    <PixelButton
      size="sm"
      tone="red"
      variant="outline"
      disabled={abortMutation.isPending}
      onClick={() => abortMutation.mutate()}
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

export type ComposerNodeData = { sessionId: string; branchId: string };

export const ComposerNode = memo(function ComposerNode(
  props: ComposerNodeData,
) {
  const { sessionId, branchId } = props;
  const draftKey = composerScopeKey(sessionId, branchId);
  const draft = useComposerStore((state) => state.drafts[draftKey]);
  const text = draft?.text ?? "";
  const intentOverride = draft?.intentOverride ?? "auto";
  const fileRefs = draft?.file_refs ?? [];
  const images = draft?.images ?? [];
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const sendMutation = useMutation({
    mutationFn: (
      input: Parameters<ReturnType<typeof getApi>["sendMessage"]>[0],
    ) => getApi().sendMessage(input),
  });
  const detected = detectIntent(text);
  const effectiveIntent: DetectedIntent =
    intentOverride === "auto" ? detected : intentOverride;
  /* 分支末端变化（发送/新生成）后 Composer 再现时重新聚焦；
     同 head 的滚动重挂载不重复聚焦 */
  const head = useDomainStore(
    (state) => selectActiveConversation(state).heads[branchId] ?? "",
  );
  const composerFocusRef = useCallback(
    autofocusOnce(`composer:${sessionId}:${branchId}:${head}`),
    [sessionId, branchId, head],
  );

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    requestConversationFollow();
    sendMutation.mutate({
      session_id: sessionId,
      branch_id: branchId,
      text: trimmed,
      intent: intentOverride,
      file_refs: fileRefs,
      images: images.map(({ name, mime, size }) => ({ name, mime, size })),
    });
    useComposerStore.getState().clearDraft(draftKey);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      send();
    }
  };

  return (
    <section
      className="chat-node chat-node--composer px-cut px-shadowed-sm"
      aria-label="消息编辑器"
    >
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
                  useComposerStore.getState().removeFileRef(draftKey, ref)
                }
              >
                ×
              </button>
            </li>
          ))}
          {images.map((image) => (
            <li key={image.id} className="chat-node__ref chat-node__ref--image">
              {image.previewUrl ? (
                <img src={image.previewUrl} alt={image.name} />
              ) : (
                <span aria-hidden="true">🖼</span>
              )}
              <span>{image.name}</span>
              <button
                type="button"
                aria-label={`移除附件 ${image.name}`}
                onClick={() =>
                  useComposerStore.getState().removeImage(draftKey, image.id)
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
          ref={composerFocusRef}
          className="chat-node__composer-input"
          aria-label="消息内容"
          placeholder="描述问题或需求，Cmd/Ctrl+Enter 发送"
          value={text}
          rows={3}
          onChange={(event) =>
            useComposerStore
              .getState()
              .setDraft(draftKey, { text: event.target.value })
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
                  .setDraft(draftKey, { intentOverride: option.value })
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        <input
          ref={imageInputRef}
          className="chat-node__file-input"
          type="file"
          accept="image/*"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            const result = useComposerStore
              .getState()
              .addImages(draftKey, files);
            setImageError(result.error);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="chat-node__attach"
          disabled={images.length >= MAX_IMAGES}
          aria-label="选择本地图片附件"
          title="最多 3 张；单张 5 MiB；合计 10 MiB"
          onClick={() => imageInputRef.current?.click()}
        >
          ＋图片
        </button>
        <PixelButton
          size="sm"
          tone="cyan"
          disabled={!text.trim() || sendMutation.isPending}
          onClick={send}
        >
          发送
        </PixelButton>
      </footer>
      {imageError ? (
        <p className="chat-node__attachment-error" role="alert">
          {imageError}
        </p>
      ) : null}
    </section>
  );
});

/* ── 业务节点 ── */

export type ConversationNodeData = {
  node: ConversationNode;
  sessionId: string;
  branchId: string;
  selected?: boolean;
};

const useBranchFrom = (sessionId: string) => {
  const setActiveBranch = useCanvasStore(
    (state) => state.setActiveConversationBranch,
  );
  const branchMutation = useMutation({
    mutationFn: (nodeId: string) =>
      getApi().branchFrom({ session_id: sessionId, node_id: nodeId }),
    onSuccess: ({ branch }) => setActiveBranch(branch.id),
  });
  return (nodeId: string) => branchMutation.mutate(nodeId);
};

export const UserMessageNode = memo(function UserMessageNode(
  props: ConversationNodeData,
) {
  const { node, sessionId, selected } = props;
  const branchFrom = useBranchFrom(sessionId);
  return (
    <NodeShell
      label="你"
      ariaLabel={
        node.redacted_at
          ? "用户消息：已删除"
          : `用户消息：${node.content.slice(0, 40)}`
      }
      selected={selected}
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
      {node.redacted_at ? (
        <RedactedContent />
      ) : (
        <p className="chat-node__content">{node.content}</p>
      )}
      {node.intent && !node.redacted_at ? (
        <p className="chat-node__meta">
          意图判定：{INTENT_LABELS[node.intent]}
        </p>
      ) : null}
    </NodeShell>
  );
});

export const ProcessNode = memo(function ProcessNode(
  props: ConversationNodeData,
) {
  const { node, sessionId, branchId, selected } = props;
  const streaming = node.state === "streaming";
  return (
    <NodeShell
      label="过程"
      state={node.state}
      ariaLabel="过程节点"
      selected={selected}
      actions={
        streaming ? (
          <StopButton sessionId={sessionId} branchId={branchId} />
        ) : undefined
      }
    >
      {node.redacted_at ? (
        <RedactedContent />
      ) : node.content ? (
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

export const ToolNode = memo(function ToolNode(props: ConversationNodeData) {
  const { node, sessionId, branchId, selected } = props;
  const tool = node.tool_activity;
  const running = node.state === "running";
  return (
    <NodeShell
      label="工具"
      state={node.state}
      ariaLabel={`工具节点：${tool?.name ?? ""}`}
      selected={selected}
      actions={
        running ? (
          <StopButton sessionId={sessionId} branchId={branchId} />
        ) : undefined
      }
    >
      {node.redacted_at ? (
        <RedactedContent />
      ) : (
        <p className="chat-node__content">{tool?.purpose ?? ""}</p>
      )}
      {!node.redacted_at ? (
        <>
          <p className="chat-node__meta">
            <code className="px-font-mono">{tool?.name}</code> ·{" "}
            {tool ? TOOL_STATE_LABELS[tool.state] : ""}
            {tool?.duration_ms != null
              ? ` · ${(tool.duration_ms / 1000).toFixed(1)}s`
              : ""}
          </p>
          {tool?.summary ? (
            <p className="chat-node__summary">
              摘要：{tool.summary.slice(0, 120)}
            </p>
          ) : null}
        </>
      ) : null}
    </NodeShell>
  );
});

export const AssistantAnswerNode = memo(function AssistantAnswerNode(
  props: ConversationNodeData,
) {
  const { node, sessionId, branchId, selected } = props;
  const streaming = node.state === "streaming";
  const createRequirementMutation = useMutation({
    mutationFn: (nodeIds: string[]) =>
      getApi().createRequirementFromChat({
        session_id: sessionId,
        branch_id: branchId,
        node_ids: nodeIds,
      }),
  });
  // PRD-CHAT-003：从连续问答节点整理为需求，来源与证据自动关联
  const createRequirement = () => {
    requestConversationFollow();
    const state = useDomainStore.getState();
    const nodeIds = ancestorChain(selectActiveConversation(state), node.id)
      .filter(
        (entry) =>
          entry.kind === "user_message" || entry.kind === "assistant_answer",
      )
      .map((entry) => entry.id);
    createRequirementMutation.mutate(nodeIds);
  };
  return (
    <NodeShell
      label="回答"
      state={node.state}
      ariaLabel="回答节点"
      selected={selected}
      actions={
        streaming ? (
          <StopButton sessionId={sessionId} branchId={branchId} />
        ) : node.state === "completed" && !node.redacted_at ? (
          <PixelButton
            size="sm"
            variant="outline"
            disabled={createRequirementMutation.isPending}
            onClick={createRequirement}
          >
            整理为需求
          </PixelButton>
        ) : undefined
      }
    >
      {node.redacted_at ? (
        <RedactedContent />
      ) : node.content ? (
        <p className="chat-node__content chat-node__content--scroll">
          {node.content}
        </p>
      ) : (
        <p className="chat-node__shell">等待首个增量…</p>
      )}
    </NodeShell>
  );
});

export const ClarificationQuestionNode = memo(
  function ClarificationQuestionNode(props: ConversationNodeData) {
    const { node, selected } = props;
    const round = useDomainStore((state) =>
      node.clarification_round_id
        ? state.clarifications[node.clarification_round_id]
        : undefined,
    );
    const requirement = useDomainStore((state) =>
      node.requirement_id ? state.requirements[node.requirement_id] : undefined,
    );
    const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
    const [customSelected, setCustomSelected] = useState(false);
    const [customText, setCustomText] = useState("");
    const [customFocusNonce, setCustomFocusNonce] = useState(0);
    const answerMutation = useMutation({
      mutationFn: () => {
        if (!round) return Promise.resolve();
        return getApi().answerClarification({
          requirement_id: round.requirement_id,
          round_id: round.id,
          answer: {
            selected_option_ids: selectedOptionIds,
            custom_text:
              round.mode === "free_text" || customSelected
                ? customText.trim()
                : null,
          },
        });
      },
    });
    /* 自由文本轮次首次出现聚焦一次；「自定义回答」每次主动选择都重新聚焦 */
    const clarificationFocusRef = useCallback(
      autofocusOnce(
        round
          ? round.mode === "free_text"
            ? `clar:${round.id}`
            : `clar:${round.id}:custom:${customFocusNonce}`
          : "clar:none",
      ),
      [round, customFocusNonce],
    );
    const effectiveState =
      requirement?.state === "cancelled" ? "cancelled" : round?.state;
    const customRequired =
      round?.mode === "free_text" || Boolean(customSelected);
    const canSubmit =
      round?.state === "pending" &&
      !answerMutation.isPending &&
      (round.mode === "free_text"
        ? Boolean(customText.trim())
        : (selectedOptionIds.length > 0 || customSelected) &&
          (!customRequired || Boolean(customText.trim())));
    const selectOption = (optionId: string) => {
      if (!round) return;
      if (round.mode === "single_choice") {
        setSelectedOptionIds([optionId]);
        setCustomSelected(false);
        return;
      }
      setSelectedOptionIds((current) =>
        current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      );
    };
    const submit = () => {
      if (!round || !canSubmit) return;
      requestConversationFollow();
      answerMutation.mutate();
    };
    return (
      <NodeShell
        label="澄清"
        state={node.state}
        statusLabel={
          effectiveState === "pending"
            ? "待回答"
            : effectiveState === "answered"
              ? "已回答"
              : effectiveState === "cancelled"
                ? "已取消"
                : undefined
        }
        statusState={
          effectiveState === "pending"
            ? "running"
            : effectiveState === "cancelled"
              ? "aborted"
              : "completed"
        }
        ariaLabel="澄清问题节点"
        selected={selected}
        actions={
          effectiveState === "pending" ? (
            <CancelRequirementButton requirementId={node.requirement_id} />
          ) : undefined
        }
      >
        {node.redacted_at ? (
          <RedactedContent />
        ) : (
          <>
            <p className="chat-node__content">
              {round?.question ?? node.content}
            </p>
            {round?.state === "pending" ? (
              <div className="chat-node__clarification nodrag nowheel">
                {round.mode !== "free_text" ? (
                  <div
                    className="chat-node__clarification-options"
                    role={
                      round.mode === "single_choice" ? "radiogroup" : "group"
                    }
                    aria-label={
                      round.mode === "single_choice"
                        ? "单选澄清选项"
                        : "多选澄清选项"
                    }
                  >
                    {round.options.map((option) => {
                      const active = selectedOptionIds.includes(option.id);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className="chat-node__clarification-option"
                          role={
                            round.mode === "single_choice"
                              ? "radio"
                              : "checkbox"
                          }
                          aria-checked={active}
                          data-active={active || undefined}
                          onClick={() => selectOption(option.id)}
                        >
                          <span
                            className="chat-node__clarification-marker"
                            aria-hidden="true"
                          >
                            {round.mode === "single_choice"
                              ? active
                                ? "●"
                                : "○"
                              : active
                                ? "■"
                                : "□"}
                          </span>
                          <span className="chat-node__clarification-copy">
                            <strong>{option.label}</strong>
                            {option.description ? (
                              <small>{option.description}</small>
                            ) : null}
                          </span>
                          {option.recommended ? (
                            <span className="chat-node__recommended">推荐</span>
                          ) : null}
                        </button>
                      );
                    })}
                    {round.allow_custom ? (
                      <button
                        type="button"
                        className="chat-node__clarification-option"
                        role={
                          round.mode === "single_choice" ? "radio" : "checkbox"
                        }
                        aria-checked={customSelected}
                        data-active={customSelected || undefined}
                        onClick={() => {
                          if (round.mode === "single_choice") {
                            setSelectedOptionIds([]);
                            setCustomSelected(true);
                            setCustomFocusNonce((nonce) => nonce + 1);
                          } else {
                            if (!customSelected) {
                              setCustomFocusNonce((nonce) => nonce + 1);
                            }
                            setCustomSelected((value) => !value);
                          }
                        }}
                      >
                        <span
                          className="chat-node__clarification-marker"
                          aria-hidden="true"
                        >
                          {round.mode === "single_choice"
                            ? customSelected
                              ? "●"
                              : "○"
                            : customSelected
                              ? "■"
                              : "□"}
                        </span>
                        <span className="chat-node__clarification-copy">
                          <strong>自定义回答</strong>
                          <small>补充选项未覆盖的约束或侧重点。</small>
                        </span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {round.mode === "free_text" || customSelected ? (
                  <PixelTextarea
                    ref={clarificationFocusRef}
                    className="chat-node__clarification-input"
                    aria-label="自定义澄清回答"
                    value={customText}
                    rows={3}
                    placeholder="输入会改变需求范围或方案的关键信息"
                    onChange={(event) => setCustomText(event.target.value)}
                  />
                ) : null}
                <PixelButton
                  size="sm"
                  tone="cyan"
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                >
                  {answerMutation.isPending ? "提交中" : "确认回答"}
                </PixelButton>
              </div>
            ) : (
              <p className="chat-node__meta">
                {effectiveState === "cancelled"
                  ? "该需求已取消。"
                  : "该问题已回答。"}
              </p>
            )}
          </>
        )}
      </NodeShell>
    );
  },
);

export const ClarificationAnswerNode = memo(function ClarificationAnswerNode(
  props: ConversationNodeData,
) {
  const { node, selected } = props;
  return (
    <NodeShell
      label="澄清回答"
      state={node.state}
      ariaLabel="澄清回答节点"
      selected={selected}
    >
      {node.redacted_at ? (
        <RedactedContent />
      ) : (
        <p className="chat-node__content">{node.content}</p>
      )}
    </NodeShell>
  );
});

export const RequirementSpecNode = memo(function RequirementSpecNode(
  props: ConversationNodeData,
) {
  const { node, selected } = props;
  const revisions = useDomainStore((state) =>
    node.requirement_id ? (state.revisions[node.requirement_id] ?? []) : [],
  );
  const requirement = useDomainStore((state) =>
    node.requirement_id ? state.requirements[node.requirement_id] : undefined,
  );
  const revision = revisions.find(
    (entry) => entry.revision === node.requirement_revision,
  );
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(revision?.spec.goal ?? node.content);
  const [userValue, setUserValue] = useState(revision?.spec.user_value ?? "");
  const saveMutation = useMutation({
    mutationFn: () => {
      if (!revision) return Promise.resolve(null);
      return getApi().updateSpec({
        requirement_id: revision.requirement_id,
        base_revision: revision.revision,
        spec: {
          ...revision.spec,
          goal: goal.trim(),
          user_value: userValue.trim(),
        },
      });
    },
    onSuccess: (result) => {
      if (result && !result.conflict) setEditing(false);
    },
  });
  const save = () => {
    if (!revision) return;
    requestConversationFollow();
    saveMutation.mutate();
  };
  return (
    <NodeShell
      label={`规格 r${node.requirement_revision ?? "?"}`}
      state={node.state}
      ariaLabel={`需求规格节点 r${node.requirement_revision ?? "?"}`}
      selected={selected}
      actions={
        <>
          {!node.redacted_at ? (
            <PixelButton
              size="sm"
              variant="outline"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "收起" : "展开"}
            </PixelButton>
          ) : null}
          {requirement?.state === "spec_ready" &&
          node.requirement_revision === requirement.latest_revision ? (
            <CancelRequirementButton requirementId={node.requirement_id} />
          ) : null}
        </>
      }
    >
      {node.redacted_at ? (
        <RedactedContent />
      ) : revision ? (
        <>
          {editing ? (
            <div className="chat-node__spec-editor nodrag nowheel">
              <label>
                目标
                <PixelTextarea
                  aria-label="规格目标"
                  value={goal}
                  rows={2}
                  onChange={(event) => setGoal(event.target.value)}
                />
              </label>
              <label>
                用户价值
                <PixelTextarea
                  aria-label="规格用户价值"
                  value={userValue}
                  rows={2}
                  onChange={(event) => setUserValue(event.target.value)}
                />
              </label>
              <div className="chat-node__inline-actions">
                <PixelButton
                  size="sm"
                  tone="cyan"
                  disabled={saveMutation.isPending}
                  onClick={save}
                >
                  保存为新 revision
                </PixelButton>
                <PixelButton
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(false)}
                >
                  取消
                </PixelButton>
              </div>
            </div>
          ) : (
            <>
              <p className="chat-node__content">{revision.spec.goal}</p>
              <p className="chat-node__meta">
                范围 {revision.spec.in_scope.length} 项 · 验收场景{" "}
                {revision.spec.scenarios.length} 项
              </p>
              {expanded ? (
                <div className="chat-node__spec-detail">
                  <p>{revision.spec.user_value}</p>
                  <ul>
                    {revision.spec.in_scope.slice(0, 4).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <PixelButton
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(true)}
                  >
                    编辑规格
                  </PixelButton>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : (
        <p className="chat-node__shell">规格数据正在对账…</p>
      )}
    </NodeShell>
  );
});

export const RequirementConfirmationNode = memo(
  function RequirementConfirmationNode(props: ConversationNodeData) {
    const { node, selected } = props;
    const requirement = useDomainStore((state) =>
      node.requirement_id ? state.requirements[node.requirement_id] : undefined,
    );
    const { data: preview } = useQuery({
      queryKey: [
        "confirmation-preview",
        node.requirement_id,
        node.requirement_revision,
      ],
      queryFn: () => getApi().getConfirmationPreview(node.requirement_id!),
      enabled: Boolean(node.requirement_id && !node.redacted_at),
    });
    const confirmed =
      requirement?.confirmed_revision === node.requirement_revision;
    const [budgetOverride, setBudgetOverride] = useState<number | null>(null);
    const canConfirm =
      requirement?.state === "spec_ready" &&
      requirement.latest_revision === node.requirement_revision;
    const confirmMutation = useMutation({
      mutationFn: () => {
        if (!node.requirement_id || node.requirement_revision == null) {
          return Promise.resolve({ run_id: null, conflict: false });
        }
        return getApi().confirmRequirement({
          requirement_id: node.requirement_id,
          revision: node.requirement_revision,
          task_budget_usd:
            budgetOverride ?? preview?.effective_task_budget_usd ?? 0,
        });
      },
    });
    const confirm = () => {
      if (!node.requirement_id || node.requirement_revision == null) return;
      requestConversationFollow();
      confirmMutation.mutate();
    };
    return (
      <NodeShell
        label="需求确认"
        state={node.state}
        statusLabel={
          confirmed
            ? "已确认"
            : requirement?.state === "cancelled"
              ? "已取消"
              : canConfirm
                ? "待确认"
                : "已过期"
        }
        statusState={
          confirmed
            ? "completed"
            : requirement?.state === "cancelled"
              ? "aborted"
              : canConfirm
                ? "running"
                : "completed"
        }
        ariaLabel="需求确认节点"
        selected={selected}
        actions={
          !node.redacted_at && canConfirm ? (
            <>
              <PixelButton
                size="sm"
                tone="green"
                disabled={confirmMutation.isPending}
                onClick={confirm}
              >
                确认并执行
              </PixelButton>
              <CancelRequirementButton requirementId={node.requirement_id} />
            </>
          ) : undefined
        }
      >
        {node.redacted_at ? (
          <RedactedContent />
        ) : (
          <>
            <p className="chat-node__content">
              {confirmed
                ? `已确认 r${node.requirement_revision}`
                : `等待确认 r${node.requirement_revision}`}
            </p>
            {preview ? (
              <ul className="chat-node__facts">
                <li>发布：{preview.publication_path}</li>
                <li>模型角色：{preview.model_roles.length} 个</li>
                <li>
                  任务预算：
                  <input
                    className="chat-node__budget-input"
                    aria-label="本任务软预算（美元）"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={budgetOverride ?? preview.effective_task_budget_usd}
                    onChange={(event) =>
                      setBudgetOverride(Number(event.target.value))
                    }
                    disabled={confirmed}
                  />
                  USD
                </li>
                <li>工作区：{preview.workspace_dirty ? "有阻断" : "干净"}</li>
              </ul>
            ) : null}
          </>
        )}
      </NodeShell>
    );
  },
);

export const ProcessGroupNode = memo(function ProcessGroupNode({
  item,
}: {
  item: Extract<BranchDisplayItem, { type: "process_group" }>;
}) {
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
