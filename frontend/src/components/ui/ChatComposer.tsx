import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core";
import { ChatComposer as AstryxChatComposer } from "@astryxdesign/core/Chat";
import { Token } from "@astryxdesign/core/Token";
import { FileText, Image, Send, Square, X } from "lucide-react";
import { getProjectFiles, uploadProjectAttachment } from "../../api/client";
import type { FileReference, ImageAttachment } from "../../types/api";

const MAX_TEXTAREA_HEIGHT = 156;

export default function ChatComposer({
  value,
  disabled,
  canSend,
  placeholder,
  sendLabel = "发送",
  stopLabel = "停止",
  onChange,
  references = [],
  images = [],
  onReferencesChange,
  onImagesChange,
  projectId,
  onSubmit,
  onStop,
  onGenerateRequirementSummary,
}: {
  value: string;
  disabled: boolean;
  canSend: boolean;
  placeholder: string;
  sendLabel?: string;
  stopLabel?: string;
  onChange: (value: string) => void;
  references?: FileReference[];
  images?: ImageAttachment[];
  onReferencesChange?: (references: FileReference[]) => void;
  onImagesChange?: (images: ImageAttachment[]) => void;
  projectId?: string;
  onSubmit: () => void | Promise<void>;
  onStop?: () => void;
  onGenerateRequirementSummary?: () => void | Promise<void>;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [fileOptions, setFileOptions] = useState<FileReference[]>([]);
  const [mention, setMention] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const running = Boolean(onStop);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashQuery = value.trim();
  const showRequirementCommand =
    Boolean(onGenerateRequirementSummary) &&
    !slashDismissed &&
    slashQuery.startsWith("/") &&
    "/生成需求说明".startsWith(slashQuery);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const height = Math.min(
      Math.max(textarea.scrollHeight, 42),
      MAX_TEXTAREA_HEIGHT,
    );
    textarea.style.height = `${height}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [value]);

  function submit() {
    if (showRequirementCommand) {
      onChange("");
      setSlashDismissed(true);
      void onGenerateRequirementSummary?.();
      return;
    }
    if (canSend) void onSubmit();
  }

  useEffect(() => {
    if (!projectId || !mention) {
      setFileOptions([]);
      return;
    }
    let cancelled = false;
    void getProjectFiles(projectId, mention.query)
      .then((files) => {
        if (!cancelled) setFileOptions(files);
      })
      .catch(() => {
        if (!cancelled) setFileOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mention, projectId]);

  function updateValue(next: string, cursor?: number) {
    onChange(next);
    if (cursor === undefined) return;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function detectMention(next: string, cursor: number) {
    const before = next.slice(0, cursor);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    setMention(
      match ? { start: cursor - match[1].length - 1, query: match[1] } : null,
    );
  }

  function selectReference(reference: FileReference) {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(
      textareaRef.current?.selectionStart ?? value.length,
    );
    const insert = `@${reference.path} `;
    updateValue(`${before}${insert}${after}`, before.length + insert.length);
    if (!references.some((item) => item.path === reference.path)) {
      onReferencesChange?.([...references, reference]);
    }
    setMention(null);
  }

  async function uploadImages(files: FileList | File[]) {
    if (!projectId || !onImagesChange) return;
    const imageFiles = Array.from(files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (imageFiles.length === 0) return;
    setUploadError(null);
    try {
      const uploaded = await Promise.all(
        imageFiles.map((file) => uploadProjectAttachment(projectId, file)),
      );
      onImagesChange([...images, ...uploaded]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "上传图片失败");
    }
  }

  const attachments =
    references.length || images.length || uploadError ? (
      <div className="rq-composer__chips">
        {references.map((reference) => (
          <Token
            key={reference.path}
            size="sm"
            icon={<FileText size={13} />}
            label={reference.path}
            onRemove={() =>
              onReferencesChange?.(
                references.filter((item) => item.path !== reference.path),
              )
            }
          />
        ))}
        {images.map((image) => (
          <Token
            key={image.path}
            size="sm"
            icon={<Image size={13} />}
            label={image.name}
            onRemove={() =>
              onImagesChange?.(
                images.filter((item) => item.path !== image.path),
              )
            }
          />
        ))}
        {uploadError ? <span role="alert">{uploadError}</span> : null}
      </div>
    ) : undefined;

  return (
    <AstryxChatComposer
      className="rq-composer nowheel nodrag"
      value={value}
      onChange={onChange}
      onSubmit={submit}
      onStop={onStop}
      isStopShown={running}
      isDisabled={disabled}
      placeholder={placeholder}
      density="compact"
      drawer={attachments}
      input={
        <div className="rq-composer__input">
          <textarea
            ref={textareaRef}
            value={value}
            disabled={disabled}
            onChange={(event) => {
              onChange(event.target.value);
              setSlashDismissed(false);
              detectMention(event.target.value, event.target.selectionStart);
            }}
            onPaste={(event) => {
              void uploadImages(event.clipboardData.files);
            }}
            onKeyDown={(event) => {
              const composing =
                event.nativeEvent.isComposing || event.keyCode === 229;
              if (
                showRequirementCommand &&
                ["ArrowDown", "ArrowUp"].includes(event.key)
              ) {
                event.preventDefault();
                return;
              }
              if (showRequirementCommand && event.key === "Escape") {
                event.preventDefault();
                setSlashDismissed(true);
                return;
              }
              if (event.key !== "Enter" || event.shiftKey || composing) return;
              event.preventDefault();
              submit();
            }}
            placeholder={placeholder}
            rows={1}
          />
          {showRequirementCommand ? (
            <div className="rq-composer__suggestions" role="listbox">
              <button
                type="button"
                role="option"
                aria-selected="true"
                onClick={submit}
              >
                <span>/生成需求说明</span>
              </button>
            </div>
          ) : null}
          {fileOptions.length > 0 && mention ? (
            <div className="rq-composer__suggestions">
              {fileOptions.slice(0, 8).map((file) => (
                <button
                  type="button"
                  key={file.path}
                  onClick={() => selectReference(file)}
                >
                  <FileText size={13} />
                  <span>{file.path}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      }
      sendButton={
        <Button
          label={running ? stopLabel : sendLabel}
          isIconOnly
          variant={running ? "secondary" : "primary"}
          isDisabled={!running && !canSend}
          onClick={running ? onStop : submit}
          icon={
            running ? (
              <Square size={15} fill="currentColor" />
            ) : (
              <Send size={15} />
            )
          }
        />
      }
      onDrop={(event) => {
        if (!projectId) return;
        event.preventDefault();
        void uploadImages(event.dataTransfer.files);
      }}
      onDragOver={(event) => {
        if (projectId) event.preventDefault();
      }}
    />
  );
}
