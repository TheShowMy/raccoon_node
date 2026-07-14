import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  Copy,
  Database,
  Minimize2,
  Wrench,
} from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type {
  SessionContentBlock,
  SessionEntry,
  SessionTranscriptPage,
} from "../../types/api";
import { formatDate } from "../../utils/format";
import RichContent from "./RichContent";

type Loader = (before?: number | null) => Promise<SessionTranscriptPage>;

function TranscriptCodeBlock({
  code,
  language = "plaintext",
}: {
  code: string;
  language?: string;
}) {
  return (
    <CodeBlock
      code={code}
      language={language}
      hasLanguageLabel={language !== "plaintext"}
      hasLineNumbers={code.split("\n").length > 4}
      isWrapped
      size="sm"
      width="100%"
    />
  );
}

function subagentEventText(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : "event";
  if (type === "message_update" && typeof event.text === "string") {
    return `输出：${event.text}`;
  }
  if (type === "tool_execution_start") {
    return `调用 ${String(event.toolName || "tool")}：${String(event.args || "")}`;
  }
  if (type === "tool_execution_end") {
    return `${event.isError ? "失败" : "完成"} ${String(event.toolName || "tool")}：${String(event.result || "")}`;
  }
  if (type === "technical_retry") return "首次技术失败，开始单角度重试";
  return type;
}

export default function SessionTranscript({
  scopeKey,
  loadPage,
  title = "原始会话",
  initiallyOpen = false,
  scrollMaxHeight = 520,
  height,
}: {
  scopeKey: string;
  loadPage: Loader;
  title?: string;
  initiallyOpen?: boolean;
  scrollMaxHeight?: number | string;
  height?: number | string;
}) {
  const loaderRef = useRef(loadPage);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(initiallyOpen);
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [invalidLines, setInvalidLines] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [filter, setFilter] = useState<"all" | "messages" | "tools">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  loaderRef.current = loadPage;

  useEffect(() => {
    setEntries([]);
    setNextBefore(null);
    setInvalidLines(0);
    setLoaded(false);
    setError(null);
    setOpen(initiallyOpen);
  }, [scopeKey, initiallyOpen]);

  useEffect(() => {
    if (!open || loaded || loading || error) return;
    void load();
  }, [open, loaded, loading, error]);

  async function load(before?: number | null) {
    const viewport = viewportRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    setLoading(true);
    setError(null);
    try {
      const page = await loaderRef.current(before);
      setEntries((current) =>
        before == null
          ? page.entries
          : [
              ...page.entries,
              ...current.filter(
                (entry) =>
                  !page.entries.some(
                    (candidate) => candidate.cursor === entry.cursor,
                  ),
              ),
            ],
      );
      setNextBefore(page.next_before);
      setInvalidLines(page.invalid_lines);
      setLoaded(true);
      if (before != null) {
        requestAnimationFrame(() => {
          if (viewport) {
            viewport.scrollTop += viewport.scrollHeight - previousHeight;
          }
        });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取会话记录失败");
    } finally {
      setLoading(false);
    }
  }

  const visible = entries.filter((entry) => {
    if (!showSystem && entry.role === "system") return false;
    if (filter === "messages") {
      return entry.kind === "message" && entry.role !== "toolResult";
    }
    if (filter === "tools") {
      return entry.blocks.some(
        (block) => block.type === "tool_call" || block.type === "tool_result",
      );
    }
    return true;
  });

  const filterBar = (
    <HStack
      gap={1}
      justify="between"
      align="center"
      padding={2}
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <HStack gap={1}>
        {(["all", "messages", "tools"] as const).map((value) => (
          <Button
            label={
              value === "all"
                ? "\u5168\u90e8"
                : value === "messages"
                  ? "\u6d88\u606f"
                  : "\u5de5\u5177"
            }
            size="sm"
            variant={filter === value ? "primary" : "ghost"}
            onClick={() => setFilter(value)}
            key={value}
          >
            {value === "all" ? "全部" : value === "messages" ? "消息" : "工具"}
          </Button>
        ))}
      </HStack>
      <CheckboxInput
        label="system"
        size="sm"
        value={showSystem}
        onChange={setShowSystem}
      />
    </HStack>
  );

  const scrollContent = (
    <Stack
      ref={viewportRef}
      gap={2}
      padding={2}
      isScrollable
      style={{ maxHeight: height ? undefined : scrollMaxHeight }}
    >
      {nextBefore !== null ? (
        <HStack justify="center">
          <Button
            label={"\u52a0\u8f7d\u66f4\u65e9\u8bb0\u5f55"}
            size="sm"
            variant="secondary"
            isDisabled={loading}
            onClick={() => void load(nextBefore)}
          >
            加载更早记录
          </Button>
        </HStack>
      ) : null}
      {visible.map((entry) => (
        <SessionEntryCard entry={entry} key={entry.cursor} />
      ))}
      {loading ? (
        <StatusRow>
          <Spinner size="sm" label="加载中" />
          <Text type="supporting" size="xsm">
            加载中…
          </Text>
        </StatusRow>
      ) : null}
      {error ? (
        <StatusRow isError>
          <Text type="supporting" size="xsm">
            {error}
          </Text>
          <Button
            label={"\u91cd\u8bd5"}
            size="sm"
            variant="ghost"
            onClick={() => setError(null)}
          >
            重试
          </Button>
        </StatusRow>
      ) : null}
      {!loading && !error && visible.length === 0 ? (
        <StatusRow>
          <Text type="supporting" size="xsm">
            暂无匹配记录
          </Text>
        </StatusRow>
      ) : null}
    </Stack>
  );

  return (
    <Card padding={0} width="100%" height={height}>
      <Button
        label={title}
        variant="ghost"
        style={{
          width: "100%",
          justifyContent: "flex-start",
          textAlign: "left",
        }}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Database size={15} />
        <span>{title}</span>
        {entries.length ? (
          <Text as="span" type="supporting" size="2xs">
            {entries.length} 条
          </Text>
        ) : null}
        <ChevronDown
          size={14}
          style={{
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform 200ms ease",
          }}
        />
      </Button>
      {open ? (
        height ? (
          <Stack height="100%" minHeight={0}>
            <StackItem size="fill" isScrollable={false}>
              <Stack height="100%" minHeight={0}>
                {filterBar}
                {invalidLines > 0 ? (
                  <StatusRow isError>
                    <AlertTriangle size={13} />
                    <Text type="supporting" size="xsm">
                      已跳过 {invalidLines} 条无效 JSONL
                    </Text>
                  </StatusRow>
                ) : null}
                <StackItem size="fill" isScrollable>
                  {scrollContent}
                </StackItem>
              </Stack>
            </StackItem>
          </Stack>
        ) : (
          <Stack>
            {filterBar}
            {invalidLines > 0 ? (
              <StatusRow isError>
                <AlertTriangle size={13} />
                <Text type="supporting" size="xsm">
                  已跳过 {invalidLines} 条无效 JSONL
                </Text>
              </StatusRow>
            ) : null}
            {scrollContent}
          </Stack>
        )
      ) : null}
    </Card>
  );
}

function StatusRow({
  children,
  isError = false,
}: {
  children: React.ReactNode;
  isError?: boolean;
}) {
  return (
    <HStack
      gap={1.5}
      justify="center"
      align="center"
      padding={2}
      style={{
        margin: "var(--spacing-4)",
        border: "1px solid",
        borderColor: isError ? "var(--color-error)" : "var(--color-border)",
        borderRadius: "var(--radius-element)",
        color: isError ? "var(--color-error)" : "var(--color-text-secondary)",
      }}
    >
      {children}
    </HStack>
  );
}

function SessionEntryCard({ entry }: { entry: SessionEntry }) {
  const roleLabels: Record<string, string> = {
    user: "用户",
    assistant: "助手",
    system: "系统",
    toolResult: "工具结果",
  };

  const roleColors: Record<string, string> = {
    user: "var(--color-accent)",
    assistant: "var(--color-text-accent)",
    system: "var(--color-text-secondary)",
    toolResult: "var(--color-success)",
  };

  const borderColor =
    entry.kind === "message"
      ? (roleColors[entry.role ?? "unknown"] ?? "var(--color-text-secondary)")
      : "var(--color-text-secondary)";

  return (
    <Card padding={3} style={{ borderLeft: `3px solid ${borderColor}` }}>
      <HStack justify="between" align="center" gap={2}>
        <HStack gap={2} align="center" style={{ minWidth: 0 }}>
          <Token label={entry.source} size="sm" color="default" />
          {entry.kind === "message" ? (
            <Text type="supporting" size="xsm">
              {entry.role ? (roleLabels[entry.role] ?? entry.role) : "未知角色"}
            </Text>
          ) : (
            <Text type="supporting" size="xsm">
              {entry.kind}
            </Text>
          )}
        </HStack>
        {entry.timestamp ? (
          <Text as="span" type="supporting" size="xsm">
            {formatDate(entry.timestamp)}
          </Text>
        ) : (
          <Text as="span" type="supporting" size="xsm">
            第 {entry.line} 行
          </Text>
        )}
      </HStack>
      {entry.blocks.length ? (
        <Stack gap={2} paddingBlock={2}>
          {entry.blocks.map((block, index) => (
            <SessionBlock block={block} key={`${block.type}-${index}`} />
          ))}
        </Stack>
      ) : null}
      {entry.kind !== "compaction" ? <RawJson value={entry.raw} /> : null}
    </Card>
  );
}

function SessionBlock({ block }: { block: SessionContentBlock }) {
  if (block.type === "text") {
    return <RichContent content={block.text} compact />;
  }
  if (block.type === "thinking") {
    return (
      <Card variant="muted" padding={0}>
        <Collapsible trigger="思考过程" defaultIsOpen={false}>
          <Stack padding={2}>
            <TranscriptCodeBlock code={block.text} />
          </Stack>
        </Collapsible>
      </Card>
    );
  }
  if (block.type === "tool_call") {
    return (
      <ToolCard title={block.name} subtitle="调用参数">
        <TranscriptCodeBlock
          code={JSON.stringify(block.arguments, null, 2)}
          language="json"
        />
      </ToolCard>
    );
  }
  if (block.type === "tool_result") {
    return (
      <ToolCard
        title={block.name}
        subtitle={block.is_error ? "执行失败" : "执行完成"}
        error={block.is_error}
      >
        {block.diff ? <SessionDiff diff={block.diff} /> : null}
        {block.output ? <TranscriptCodeBlock code={block.output} /> : null}
      </ToolCard>
    );
  }
  if (block.type === "subagents") {
    return (
      <Card variant="muted" padding={0}>
        <Collapsible
          trigger={`隔离审核子代理 · ${block.reviews.filter((review) => review.transport_status === "completed").length}/${block.selection?.angles.length ?? block.reviews.length}`}
          defaultIsOpen={false}
        >
          <Stack gap={2} padding={2}>
            {block.selection ? (
              <Card variant="muted" padding={2}>
                <Stack gap={1}>
                  <Text type="label" weight="semibold">
                    风险分类：{block.selection.classification}
                  </Text>
                  <Text type="supporting">
                    已选：{block.selection.angles.join("、")}
                    {block.selection.skippedAngles.length
                      ? " · 跳过：" + block.selection.skippedAngles.join("、")
                      : ""}
                  </Text>
                  <Text type="supporting" size="3xs">
                    {block.selection.reasons.join("；")} ·{" "}
                    {block.selection.fileCount} 个文件 ·{" "}
                    {block.selection.changedLines} 行改动 ·{" "}
                    {block.selection.diffBytes} bytes
                  </Text>
                </Stack>
              </Card>
            ) : null}
            {block.reviews.map((review) => (
              <Card key={review.angle} variant="muted" padding={2}>
                <Stack gap={1}>
                  <Text type="label" weight="semibold">
                    {review.angle} · {review.transport_status}
                  </Text>
                  {review.context_mode ? (
                    <Text type="supporting" size="3xs">
                      {review.context_mode === "blind"
                        ? "需求隔离盲审"
                        : "行为契约可见"}
                      {review.context_bytes != null
                        ? ` · 输入 ${review.context_bytes} bytes`
                        : ""}
                      {review.context_hash
                        ? ` · SHA-256 ${review.context_hash.slice(0, 12)}`
                        : ""}
                    </Text>
                  ) : null}
                  <Text type="supporting">
                    {review.result
                      ? `${review.result.findings.filter((finding) => finding.priority === "P0" || finding.priority === "P1").length} 个 P0/P1 · ${review.result.findings.length} 个 finding`
                      : review.error || "没有结构化结果"}
                  </Text>
                  {review.result?.findings.map((finding) => (
                    <Text
                      key={`${finding.priority}:${finding.path}:${finding.location}:${finding.summary}`}
                      type="supporting"
                      size="3xs"
                    >
                      {finding.priority} · {finding.summary} · 证据：
                      {finding.evidence}
                      {finding.remediation
                        ? ` · 修复：${finding.remediation}`
                        : ""}
                    </Text>
                  ))}
                  {review.events?.length ? (
                    <Collapsible
                      trigger={`精简过程 (${review.events.length})`}
                      defaultIsOpen={false}
                    >
                      <Stack padding={1}>
                        <TranscriptCodeBlock
                          code={review.events.map(subagentEventText).join("\n")}
                        />
                      </Stack>
                    </Collapsible>
                  ) : null}
                  {review.usage ? (
                    <Text type="supporting" size="3xs">
                      输入 {review.usage.input} · 输出 {review.usage.output} ·
                      缓存读取 {review.usage.cacheRead} · 缓存写入{" "}
                      {review.usage.cacheWrite}
                      {review.usage.context
                        ? ` · Context ${review.usage.context.percent.toFixed(1)}%`
                        : ""}
                      {review.turns ? ` · ${review.turns} turns` : ""}
                      {review.retry_count
                        ? ` · ${review.retry_count} 次技术重试`
                        : ""}
                      {review.submission_correction_count
                        ? ` · ${review.submission_correction_count} 次结构纠正`
                        : ""}
                      {review.duration_ms
                        ? ` · ${(review.duration_ms / 1000).toFixed(1)}s`
                        : ""}
                    </Text>
                  ) : null}
                  {review.runtime ? (
                    <Text type="supporting" size="3xs">
                      空闲阈值{" "}
                      {(review.runtime.idleTimeoutMs / 1000).toFixed(0)}s · 活动{" "}
                      {review.runtime.activityCount} 次 · 空闲告警{" "}
                      {review.runtime.idleWarningCount} 次
                    </Text>
                  ) : null}
                  {review.session_persisted || review.events_truncated ? (
                    <Text type="supporting" size="3xs">
                      {review.session_persisted
                        ? "警告：子 Agent 意外产生持久 session。"
                        : "调试事件已截断，结构化结论不受影响。"}
                    </Text>
                  ) : null}
                </Stack>
              </Card>
            ))}
          </Stack>
        </Collapsible>
      </Card>
    );
  }
  if (block.type === "compaction") {
    const reason =
      block.reason === "manual"
        ? "手动"
        : block.reason === "threshold"
          ? "达到阈值"
          : block.reason === "overflow"
            ? "Context 溢出"
            : "Pi 原生";
    const status =
      block.status === "completed"
        ? "压缩完成"
        : block.status === "aborted"
          ? "压缩已取消"
          : block.status === "failed"
            ? "压缩失败"
            : "压缩中";
    return (
      <Card variant="muted" padding={2}>
        <Stack gap={1}>
          <HStack gap={1.5} align="center">
            <Minimize2 size={13} />
            <Text type="label" size="xsm" weight="semibold">
              {status} · {reason}
            </Text>
          </HStack>
          {block.tokens_before !== null ? (
            <Text type="supporting" size="3xs">
              压缩前 {block.tokens_before.toLocaleString()} tokens
              {block.estimated_tokens_after !== null
                ? ` · 压缩后约 ${block.estimated_tokens_after.toLocaleString()} tokens`
                : ""}
              {block.estimated_tokens_saved !== null
                ? ` · 预计节省 ${block.estimated_tokens_saved.toLocaleString()} tokens`
                : ""}
            </Text>
          ) : null}
          {block.read_file_count || block.modified_file_count ? (
            <Text type="supporting" size="3xs">
              文件上下文：读取 {block.read_file_count} · 修改{" "}
              {block.modified_file_count}
              {block.from_hook ? " · Extension 生成摘要" : ""}
            </Text>
          ) : null}
          <Text type="supporting" size="3xs">
            {block.will_retry ? "压缩后将自动重试 · " : ""}
            {block.usage_known
              ? "压缩调用 usage 已记录"
              : block.estimated_tokens_after !== null
                ? "压缩后 token 为估算值，供应商 usage 未提供"
                : "Pi session 未保存压缩后估算，供应商 usage 未提供"}
          </Text>
          {block.error ? (
            <Text
              type="supporting"
              size="3xs"
              style={{ color: "var(--color-error)" }}
            >
              {block.error}
            </Text>
          ) : null}
        </Stack>
      </Card>
    );
  }
  return (
    <Card variant="muted" padding={0}>
      <Collapsible
        trigger={`未识别内容：${block.block_type}`}
        defaultIsOpen={false}
      >
        <Stack padding={2}>
          <TranscriptCodeBlock
            code={JSON.stringify(block.raw, null, 2)}
            language="json"
          />
        </Stack>
      </Collapsible>
    </Card>
  );
}

function ToolCard({
  title,
  subtitle,
  error = false,
  children,
}: {
  title: string;
  subtitle: string;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card
      variant="muted"
      padding={0}
      style={error ? { borderColor: "var(--color-error)" } : undefined}
    >
      <Collapsible
        trigger={
          <HStack gap={1.5} align="center">
            <Wrench size={13} />
            <Text type="supporting" size="xsm" weight="semibold">
              {title}
            </Text>
            <Text type="supporting" size="2xs">
              {subtitle}
            </Text>
          </HStack>
        }
        defaultIsOpen={false}
      >
        <Stack padding={2}>{children}</Stack>
      </Collapsible>
    </Card>
  );
}

function SessionDiff({ diff }: { diff: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = diff.split("\n");
  const visible = expanded ? lines : lines.slice(0, 180);

  return (
    <div className="session-diff">
      <div>
        <span>{lines.length} 行</span>
        <Button
          label={"\u590d\u5236 diff"}
          size="sm"
          variant="ghost"
          icon={<Copy size={12} />}
          onClick={() => {
            if (navigator.clipboard) {
              void navigator.clipboard.writeText(diff).catch(() => {});
            }
          }}
        >
          复制 diff
        </Button>
      </div>
      <pre>
        {visible.map((line, index) => (
          <span
            className={
              line.startsWith("+") && !line.startsWith("+++")
                ? "is-added"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "is-removed"
                  : line.startsWith("@@")
                    ? "is-hunk"
                    : ""
            }
            key={`${index}-${line}`}
          >
            {line || " "}
          </span>
        ))}
      </pre>
      {lines.length > 180 && !expanded ? (
        <Button
          label={`\u5c55\u5f00\u5168\u90e8 ${lines.length} \u884c`}
          size="sm"
          variant="ghost"
          onClick={() => setExpanded(true)}
        >
          展开全部 {lines.length} 行
        </Button>
      ) : null}
    </div>
  );
}

function RawJson({ value }: { value: unknown }) {
  return (
    <Card variant="muted" padding={0}>
      <Collapsible
        trigger={
          <HStack gap={1.5} align="center">
            <Braces size={12} />
            <Text type="supporting" size="xsm">
              原始 JSON
            </Text>
          </HStack>
        }
        defaultIsOpen={false}
      >
        <Stack padding={2}>
          <TranscriptCodeBlock
            code={JSON.stringify(value, null, 2)}
            language="json"
          />
        </Stack>
      </Collapsible>
    </Card>
  );
}
