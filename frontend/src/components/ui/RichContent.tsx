import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Children, isValidElement, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textFromNode(node.props.children);
  }
  return "";
}

function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return null;
  return trimmed;
}

export default function RichContent({
  content,
  compact = false,
}: {
  content: string;
  compact?: boolean;
}) {
  if (!content.trim()) return null;

  return (
    <div className={`rich-content ${compact ? "rich-content--compact" : ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...props }) {
            const safeHref = sanitizeUrl(href ?? "");
            if (!safeHref) {
              return <span>{children}</span>;
            }
            const external = safeHref.startsWith("http");
            return (
              <a
                {...props}
                href={safeHref}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
              >
                {children}
              </a>
            );
          },
          pre({ children }) {
            const child = Children.toArray(children)[0];
            const language =
              isValidElement<{ className?: string }>(child) &&
              child.props.className?.startsWith("language-")
                ? child.props.className.slice("language-".length)
                : "";
            const text = textFromNode(children).replace(/\n$/, "");
            return (
              <CodeBlock
                code={text}
                language={language || "plaintext"}
                hasLanguageLabel={language !== ""}
                hasLineNumbers={text.split("\n").length > 4}
                isWrapped
                size="sm"
                width="100%"
              />
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
