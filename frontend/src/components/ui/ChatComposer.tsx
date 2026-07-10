import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChatComposer as AstryxChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatSendButton,
} from "@astryxdesign/core/Chat";
import type { ChatComposerTrigger } from "@astryxdesign/core/Chat";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import type { SearchSource } from "@astryxdesign/core/Typeahead";
import { Stack, Text, Token } from "@astryxdesign/core";
import { FileText, Image } from "lucide-react";
import { getProjectFiles, uploadProjectAttachment } from "../../api/client";
import type { FileReference, ImageAttachment } from "../../types/api";

const ALLOWED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension ? ALLOWED_IMAGE_EXTENSIONS.includes(extension) : false;
}

function isComposingEnter(event: React.KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    event.nativeEvent.isComposing === true
  );
}

function fileSignature(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export default function ChatComposer({
  value,
  disabled,
  canSend,
  placeholder,
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
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const recentUploadsRef = useRef<Map<string, number>>(new Map());
  const running = Boolean(onStop);
  const trimmedValue = value.trim();
  const commandMatches =
    trimmedValue.startsWith("/") && "/生成需求说明".startsWith(trimmedValue);
  const showRequirementCommand =
    Boolean(onGenerateRequirementSummary) && commandMatches && !slashDismissed;

  useEffect(() => {
    setSlashDismissed(false);
  }, [value]);

  async function uploadImages(files: FileList | File[]) {
    if (!projectId || !onImagesChange) return;
    const now = Date.now();
    const duplicates = recentUploadsRef.current;
    const imageFiles = Array.from(files).filter((file) => {
      if (!isImageFile(file)) return false;
      const signature = fileSignature(file);
      const last = duplicates.get(signature);
      if (last && now - last < 500) return false;
      duplicates.set(signature, now);
      return true;
    });
    for (const [signature, timestamp] of duplicates) {
      if (now - timestamp > 5000) duplicates.delete(signature);
    }
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

  function handleGenerateRequirementSummary() {
    setUploadError(null);
    void Promise.resolve(onGenerateRequirementSummary?.()).catch((error) => {
      setUploadError(
        error instanceof Error ? error.message : "生成需求说明失败",
      );
    });
  }

  function handleSubmit() {
    if (showRequirementCommand) {
      handleGenerateRequirementSummary();
      return;
    }
    if (!canSend) return;
    void Promise.resolve(onSubmit()).catch((error) => {
      setUploadError(error instanceof Error ? error.message : "发送失败");
    });
  }

  const fileSearchSource = useMemo<SearchSource>(() => {
    let controller: AbortController | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    return {
      cancel() {
        controller?.abort();
        controller = null;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
      },
      search(query) {
        if (!projectId) return Promise.resolve([]);
        controller?.abort();
        if (debounceTimer) clearTimeout(debounceTimer);
        return new Promise((resolve) => {
          debounceTimer = setTimeout(async () => {
            debounceTimer = null;
            controller = new AbortController();
            try {
              const files = await getProjectFiles(
                projectId,
                query,
                controller.signal,
              );
              resolve(
                files.map((file) => ({ id: file.path, label: file.path })),
              );
            } catch (error) {
              resolve([]);
            } finally {
              controller = null;
            }
          }, 150);
        });
      },
      bootstrap() {
        return [];
      },
    };
  }, [projectId]);

  const triggers = useMemo<ChatComposerTrigger[]>(() => {
    const fileTrigger: ChatComposerTrigger = {
      character: "@",
      searchSource: fileSearchSource,
      onSelect(item) {
        const path = item.id;
        if (!references.some((reference) => reference.path === path)) {
          onReferencesChange?.([...references, { path }]);
        }
        return `@${path} `;
      },
      menuLabel: "引用文件",
    };

    const slashTrigger: ChatComposerTrigger | null =
      onGenerateRequirementSummary
        ? {
            character: "/",
            searchSource: createStaticSource([
              { id: "generate", label: "/生成需求说明" },
            ]),
            onSelect() {
              handleGenerateRequirementSummary();
              return "";
            },
            menuLabel: "命令",
          }
        : null;

    return slashTrigger ? [fileTrigger, slashTrigger] : [fileTrigger];
  }, [
    fileSearchSource,
    references,
    onReferencesChange,
    onGenerateRequirementSummary,
    handleGenerateRequirementSummary,
  ]);

  const drawer = useMemo(() => {
    const count = references.length + images.length + (uploadError ? 1 : 0);
    if (count === 0) return undefined;
    return (
      <ChatComposerDrawer count={count}>
        <Stack direction="horizontal" wrap="wrap" gap={1.5}>
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
          {uploadError ? (
            <Text type="supporting" style={{ color: "var(--color-error)" }}>
              {uploadError}
            </Text>
          ) : null}
        </Stack>
      </ChatComposerDrawer>
    );
  }, [references, images, uploadError, onReferencesChange, onImagesChange]);

  return (
    <AstryxChatComposer
      className="nowheel nodrag"
      value={value}
      onChange={onChange}
      onSubmit={handleSubmit}
      onStop={onStop}
      isStopShown={running}
      isDisabled={disabled}
      placeholder={placeholder}
      density="compact"
      drawer={drawer}
      onKeyDownCapture={(event) => {
        if (isComposingEnter(event)) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (event.key === "Escape" && showRequirementCommand) {
          setSlashDismissed(true);
        }
      }}
      input={
        <ChatComposerInput
          value={value}
          onChange={onChange}
          isDisabled={disabled}
          placeholder={placeholder}
          label={placeholder}
          maxRows={6}
          triggers={triggers}
          onFiles={(files) => void uploadImages(files)}
          pasteAsToken={false}
        />
      }
      sendButton={<ChatSendButton isDisabled={!running && !canSend} />}
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
