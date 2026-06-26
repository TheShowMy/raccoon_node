import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [fileOptions, setFileOptions] = useState<FileReference[]>([]);
  const [mention, setMention] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const running = Boolean(onStop);

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

  return (
    <form
      className="rq-composer nowheel nodrag"
      onDrop={(event) => {
        if (!projectId) return;
        event.preventDefault();
        void uploadImages(event.dataTransfer.files);
      }}
      onDragOver={(event) => {
        if (projectId) event.preventDefault();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
          detectMention(event.target.value, event.target.selectionStart);
        }}
        onPaste={(event) => {
          void uploadImages(event.clipboardData.files);
        }}
        onKeyDown={(event) => {
          const composing =
            event.nativeEvent.isComposing || event.keyCode === 229;
          if (event.key !== "Enter" || event.shiftKey || composing) return;
          event.preventDefault();
          submit();
        }}
        placeholder={placeholder}
        rows={1}
      />
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
      {running ? (
        <button
          type="button"
          className="rq-composer__stop"
          onClick={onStop}
          aria-label={stopLabel}
          title={stopLabel}
        >
          <Square size={15} fill="currentColor" />
        </button>
      ) : (
        <button type="submit" disabled={!canSend} aria-label={sendLabel}>
          <Send size={15} />
        </button>
      )}
      {references.length || images.length || uploadError ? (
        <div className="rq-composer__chips">
          {references.map((reference) => (
            <button
              type="button"
              key={reference.path}
              onClick={() =>
                onReferencesChange?.(
                  references.filter((item) => item.path !== reference.path),
                )
              }
            >
              <FileText size={13} />
              <span>{reference.path}</span>
              <X size={12} />
            </button>
          ))}
          {images.map((image) => (
            <button
              type="button"
              key={image.path}
              onClick={() =>
                onImagesChange?.(
                  images.filter((item) => item.path !== image.path),
                )
              }
            >
              <Image size={13} />
              <span>{image.name}</span>
              <X size={12} />
            </button>
          ))}
          {uploadError ? <span role="alert">{uploadError}</span> : null}
        </div>
      ) : null}
    </form>
  );
}
