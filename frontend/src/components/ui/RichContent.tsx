import { Children, isValidElement, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="rich-content__copy"
      aria-label="复制代码"
      onClick={() => {
        if (!navigator.clipboard) return;
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => setCopied(false));
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textFromNode(node.props.children);
  }
  return "";
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
            const external = href?.startsWith("http");
            return (
              <a
                {...props}
                href={href}
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
              <div className="rich-content__code">
                <div>
                  <span>{language || "text"}</span>
                  <CopyButton text={text} />
                </div>
                <pre>{children}</pre>
              </div>
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
