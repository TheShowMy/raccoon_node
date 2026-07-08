import { ChatToolCalls, type ChatToolCallItem } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import type { ProcessRow } from "../../utils/format";

export default function ProcessStreamRows({
  rows,
  running = false,
}: {
  rows: ProcessRow[];
  running?: boolean;
}) {
  if (rows.length === 0) return null;
  const calls = rows.map((row): ChatToolCallItem => {
    const content = row.type === "tool" ? row.output : row.content;
    return {
      key: row.id,
      name: row.type === "tool" ? row.toolName : "Thinking",
      target: row.type === "tool" ? row.preview : undefined,
      status:
        row.status === "running"
          ? "running"
          : row.status === "error"
            ? "error"
            : "complete",
      resultDetail: content.trim() ? (
        <CodeBlock
          code={content}
          language="plaintext"
          hasLanguageLabel={false}
          hasLineNumbers={content.split("\n").length > 4}
          isWrapped
          maxHeight="calc(var(--spacing) * 55)"
          size="sm"
          width="100%"
          container="section"
        />
      ) : undefined,
      data: row,
    };
  });

  return (
    <section className="rq-process" aria-label="过程">
      <ChatToolCalls
        calls={calls}
        label="过程"
        isExpanded={running ? true : undefined}
        defaultIsExpanded={running || rows.length <= 1}
      />
    </section>
  );
}

export function ThinkingIndicator() {
  return (
    <div className="rq-thinking-indicator" aria-label="正在思考">
      <span aria-hidden="true">Thinking</span>
      <span className="rq-thinking-indicator__dots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </div>
  );
}
