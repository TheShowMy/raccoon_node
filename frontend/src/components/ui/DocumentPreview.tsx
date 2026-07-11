import { useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Copy, FileText, Loader2 } from "lucide-react";
import { getProjectFileContent } from "../../api/client";
import RichContent from "./RichContent";

export default function DocumentPreview({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const markdown = /\.(md|markdown|mdx)$/i.test(path);
  const canCopy =
    typeof navigator !== "undefined" && Boolean(navigator.clipboard);

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next || content !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      setContent((await getProjectFileContent(projectId, path)).content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取文件失败");
    } finally {
      setLoading(false);
    }
  }

  function copyContent() {
    if (canCopy && content !== null) {
      void navigator.clipboard.writeText(content).catch(() => {});
    }
  }

  return (
    <Collapsible
      isOpen={open}
      onOpenChange={(next) => void handleOpenChange(next)}
      trigger={
        <Stack direction="horizontal" gap={1.5} align="center" width="100%">
          <FileText size={13} aria-hidden />
          <Text type="label" maxLines={1} wordBreak="break-all">
            {path}
          </Text>
        </Stack>
      }
    >
      {open ? (
        <Stack
          gap={2}
          padding={3}
          isScrollable
          style={{ maxHeight: "calc(var(--spacing-1) * 90)" }}
        >
          {loading ? (
            <Stack direction="horizontal" gap={2} align="center">
              <Loader2 size={14} className="spin-icon" />
              <Text type="supporting">加载中...</Text>
            </Stack>
          ) : error ? (
            <Text type="supporting" color="accent">
              {error}
            </Text>
          ) : content !== null ? (
            <>
              <Stack direction="horizontal" justify="end">
                <IconButton
                  label="复制文件内容"
                  tooltip="复制文件内容"
                  icon={<Copy size={13} />}
                  size="sm"
                  variant="ghost"
                  isDisabled={!canCopy}
                  onClick={copyContent}
                />
              </Stack>
              {markdown ? (
                <RichContent content={content} />
              ) : (
                <CodeBlock
                  code={content}
                  language="plaintext"
                  title={path}
                  hasLanguageLabel={false}
                  hasLineNumbers={content.split("\n").length > 4}
                  isWrapped
                  maxHeight="calc(var(--spacing-1) * 80)"
                  size="sm"
                  width="100%"
                />
              )}
            </>
          ) : null}
        </Stack>
      ) : null}
    </Collapsible>
  );
}
