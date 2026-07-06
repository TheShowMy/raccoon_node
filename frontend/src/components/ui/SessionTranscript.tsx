import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  Copy,
  Database,
  Loader2,
  Wrench,
} from "lucide-react";
import type {
  SessionContentBlock,
  SessionEntry,
  SessionTranscriptPage,
} from "../../types/api";
import { formatDate } from "../../utils/format";
import RichContent from "./RichContent";

type Loader = (before?: number | null) => Promise<SessionTranscriptPage>;

export default function SessionTranscript({
  scopeKey,
  loadPage,
  title = "原始会话",
  initiallyOpen = false,
}: {
  scopeKey: string;
  loadPage: Loader;
  title?: string;
  initiallyOpen?: boolean;
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

  return (
    <section className={`session-transcript ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="session-transcript__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Database size={15} />
        <span>{title}</span>
        {entries.length ? <em>{entries.length} 条</em> : null}
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="session-transcript__panel">
          <div className="session-transcript__filters">
            {(["all", "messages", "tools"] as const).map((value) => (
              <button
                type="button"
                className={filter === value ? "is-active" : ""}
                onClick={() => setFilter(value)}
                key={value}
              >
                {value === "all"
                  ? "全部"
                  : value === "messages"
                    ? "消息"
                    : "工具"}
              </button>
            ))}
            <label>
              <input
                type="checkbox"
                checked={showSystem}
                onChange={(event) => setShowSystem(event.target.checked)}
              />
              system
            </label>
          </div>
          {invalidLines > 0 ? (
            <p className="session-transcript__warning">
              <AlertTriangle size={13} />
              已跳过 {invalidLines} 条无效 JSONL
            </p>
          ) : null}
          <div ref={viewportRef} className="session-transcript__entries">
            {nextBefore !== null ? (
              <button
                type="button"
                className="session-transcript__earlier"
                disabled={loading}
                onClick={() => void load(nextBefore)}
              >
                加载更早记录
              </button>
            ) : null}
            {visible.map((entry) => (
              <SessionEntryCard entry={entry} key={entry.cursor} />
            ))}
            {loading ? (
              <p className="session-transcript__empty">
                <Loader2 size={14} className="spin-icon" />
                加载中…
              </p>
            ) : null}
            {error ? (
              <div className="session-transcript__empty is-error">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)}>
                  重试
                </button>
              </div>
            ) : null}
            {!loading && !error && visible.length === 0 ? (
              <p className="session-transcript__empty">暂无匹配记录</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SessionEntryCard({ entry }: { entry: SessionEntry }) {
  const roleLabels: Record<string, string> = {
    user: "用户",
    assistant: "助手",
    system: "系统",
    toolResult: "工具结果",
  };

  if (entry.kind !== "message") {
    return (
      <article className="session-entry session-entry--meta">
        <span>{entry.kind}</span>
        <b>{entry.source}</b>
        {entry.timestamp ? <time>{formatDate(entry.timestamp)}</time> : null}
        <RawJson value={entry.raw} />
      </article>
    );
  }

  return (
    <article
      className={`session-entry session-entry--${entry.role ?? "unknown"}`}
    >
      <header>
        <span>
          <b>{entry.source}</b>
          {entry.role ? (roleLabels[entry.role] ?? entry.role) : "未知角色"}
        </span>
        {entry.timestamp ? (
          <time dateTime={entry.timestamp}>{formatDate(entry.timestamp)}</time>
        ) : (
          <time>第 {entry.line} 行</time>
        )}
      </header>
      <div className="session-entry__blocks">
        {entry.blocks.map((block, index) => (
          <SessionBlock block={block} key={`${block.type}-${index}`} />
        ))}
      </div>
      <RawJson value={entry.raw} />
    </article>
  );
}

function SessionBlock({ block }: { block: SessionContentBlock }) {
  if (block.type === "text") {
    return <RichContent content={block.text} compact />;
  }
  if (block.type === "thinking") {
    return (
      <details className="session-thinking">
        <summary>思考过程</summary>
        <pre>{block.text}</pre>
      </details>
    );
  }
  if (block.type === "tool_call") {
    return (
      <ToolCard title={block.name} subtitle="调用参数">
        <pre>{JSON.stringify(block.arguments, null, 2)}</pre>
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
        {block.output ? <pre>{block.output}</pre> : null}
      </ToolCard>
    );
  }
  return (
    <details className="session-unknown">
      <summary>未识别内容：{block.block_type}</summary>
      <pre>{JSON.stringify(block.raw, null, 2)}</pre>
    </details>
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
    <details className={`session-tool ${error ? "is-error" : ""}`}>
      <summary>
        <Wrench size={13} />
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </summary>
      <div>{children}</div>
    </details>
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
        <button
          type="button"
          onClick={() => {
            if (navigator.clipboard) {
              void navigator.clipboard.writeText(diff).catch(() => {});
            }
          }}
        >
          <Copy size={12} />
          复制 diff
        </button>
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
        <button type="button" onClick={() => setExpanded(true)}>
          展开全部 {lines.length} 行
        </button>
      ) : null}
    </div>
  );
}

function RawJson({ value }: { value: unknown }) {
  return (
    <details className="session-raw">
      <summary>
        <Braces size={12} />
        原始 JSON
      </summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
