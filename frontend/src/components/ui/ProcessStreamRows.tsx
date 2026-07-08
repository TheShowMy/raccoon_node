import { ChatToolCalls, type ChatToolCallItem } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Spinner } from "@astryxdesign/core/Spinner";
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
    <section aria-label="过程">
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
  return <Spinner size="sm" label="Thinking" aria-label="正在思考" />;
}
