import { useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  type ChatComposerTrigger,
} from "@astryxdesign/core/Chat";
import { Carousel } from "@astryxdesign/core/Carousel";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Token } from "@astryxdesign/core/Token";
import {
  createStaticSource,
  type SearchableItem,
} from "@astryxdesign/core/Typeahead";
import { Paperclip, X } from "lucide-react";
import { getProjectFiles, uploadProjectAttachment } from "../../api/client";
import type {
  FileReference,
  ImageAttachment,
  StartNodeData,
} from "../../types/api";
import RequirementPrompt from "./RequirementPrompt";
import { parseProjectChatCommand } from "./commands";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

const COMMANDS: SearchableItem[] = [
  { id: "requirement", label: "需求生成" },
  { id: "new-session", label: "新建会话" },
];

function appendUniqueReference(
  references: FileReference[],
  path: string,
): FileReference[] {
  return references.some((item) => item.path === path)
    ? references
    : [...references, { path }];
}

export default function AstryxComposer({
  data,
  requirementMode,
  onRequirementModeChange,
}: {
  data: ChatData;
  requirementMode: boolean;
  onRequirementModeChange: (value: boolean) => void;
}) {
  const [files, setFiles] = useState<FileReference[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getProjectFiles(data.project.id, "", controller.signal)
      .then(setFiles)
      .catch(() => setFiles([]));
    return () => controller.abort();
  }, [data.project.id]);

  const references = requirementMode
    ? (data.references ?? [])
    : (data.projectChatReferences ?? []);
  const images = requirementMode
    ? (data.images ?? [])
    : (data.projectChatImages ?? []);
  const setReferences = requirementMode
    ? data.onReferencesChange
    : data.onProjectChatReferencesChange;
  const setImages = requirementMode
    ? data.onImagesChange
    : data.onProjectChatImagesChange;
  const value = requirementMode ? data.input : data.projectChatInput;
  const setValue = requirementMode
    ? data.onInputChange
    : data.onProjectChatInputChange;
  const promptVisible = Boolean(
    requirementMode && data.conversation?.prompt && !data.promptDismissed,
  );

  const fileSource = useMemo(
    () =>
      createStaticSource(
        files.map((file) => ({ id: file.path, label: file.path })),
      ),
    [files],
  );
  const commandSource = useMemo(() => createStaticSource(COMMANDS), []);

  const triggers = useMemo<ChatComposerTrigger[]>(() => {
    const fileTrigger: ChatComposerTrigger = {
      character: "@",
      searchSource: fileSource,
      onSelect: (item) => {
        setReferences?.(appendUniqueReference(references, item.id));
        return { value: `@${item.id}`, label: item.label, variant: "blue" };
      },
    };
    if (requirementMode) return [fileTrigger];
    const commandTrigger: ChatComposerTrigger = {
      character: "/",
      searchSource: commandSource,
      onSelect: (item) => {
        if (item.id === "requirement") {
          data.onProjectChatInputChange("");
          onRequirementModeChange(true);
        } else {
          setResetOpen(true);
        }
        return {
          value: `/${item.label}`,
          label: `/${item.label}`,
          variant: "yellow",
        };
      },
    };
    return [fileTrigger, commandTrigger];
  }, [
    commandSource,
    data,
    fileSource,
    onRequirementModeChange,
    references,
    requirementMode,
    setReferences,
  ]);

  const upload = async (incoming: File[]) => {
    const imageFiles = incoming.filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!imageFiles.length) {
      setAttachmentError("只支持图片附件");
      return;
    }
    setUploading(true);
    setAttachmentError(null);
    try {
      const uploaded: ImageAttachment[] = [];
      for (const file of imageFiles) {
        uploaded.push(await uploadProjectAttachment(data.project.id, file));
      }
      setImages?.([...images, ...uploaded]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const submit = async (submitted: string) => {
    const message = submitted.trim();
    if (!message) return;
    if (!requirementMode) {
      const command = parseProjectChatCommand(message);
      if (command.type === "requirement") {
        data.onProjectChatInputChange("");
        onRequirementModeChange(true);
        if (command.description) await data.onSend(command.description);
        return;
      }
      if (command.type === "new-session") {
        setResetOpen(true);
        return;
      }
      await data.onProjectChatSend();
      return;
    }
    await data.onSend();
  };

  const drawerCount =
    references.length + images.length + (promptVisible ? 1 : 0);
  const drawer = drawerCount ? (
    <ChatComposerDrawer
      count={drawerCount}
      label={promptVisible ? "需要处理" : "上下文附件"}
      defaultIsCollapsed={false}
    >
      <VStack gap={3} width="100%">
        {promptVisible ? <RequirementPrompt data={data} /> : null}
        {images.length ? (
          <Carousel gap={1}>
            {images.map((image) => (
              <Thumbnail
                key={image.path}
                src={`/api/projects/${encodeURIComponent(data.project.id)}/attachments/${encodeURIComponent(image.path)}`}
                alt={image.name}
                label={image.name}
                onRemove={() =>
                  setImages?.(images.filter((item) => item.path !== image.path))
                }
              />
            ))}
          </Carousel>
        ) : null}
        {references.length ? (
          <HStack gap={1} wrap="wrap">
            {references.map((reference) => (
              <Token
                key={reference.path}
                label={reference.path}
                onRemove={() =>
                  setReferences?.(
                    references.filter((item) => item.path !== reference.path),
                  )
                }
              />
            ))}
          </HStack>
        ) : null}
      </VStack>
    </ChatComposerDrawer>
  ) : undefined;

  const running = requirementMode
    ? Boolean(data.busy || data.conversation?.running)
    : Boolean(data.projectChatBusy || data.projectChat?.running);
  const composerDisabled = promptVisible || uploading || running;
  const error =
    attachmentError ?? (requirementMode ? data.error : data.projectChatError);

  return (
    <>
      <ChatComposer
        value={value}
        onChange={setValue}
        onSubmit={(submitted) => void submit(submitted)}
        onStop={() =>
          void (requirementMode ? data.onCancel() : data.onProjectChatAbort())
        }
        isStopShown={running}
        isDisabled={composerDisabled}
        density="balanced"
        placeholder={
          requirementMode ? "描述或补充需求" : "询问项目，输入 / 选择命令"
        }
        drawer={drawer}
        input={
          <ChatComposerInput
            value={value}
            onChange={setValue}
            triggers={triggers}
            onFiles={(incoming) => void upload(incoming)}
            onSubmit={(submitted) => void submit(submitted)}
            isDisabled={composerDisabled}
            label={requirementMode ? "需求输入" : "项目聊天输入"}
            maxRows={6}
          />
        }
        headerActions={
          <>
            <Button
              label="添加图片"
              tooltip="添加图片"
              isIconOnly
              size="sm"
              variant="ghost"
              icon={<Paperclip size={16} />}
              isLoading={uploading}
              isDisabled={running}
              onClick={() => inputRef.current?.click()}
            />
            {requirementMode && !data.requirement ? (
              <Button
                label="返回项目聊天"
                tooltip="返回项目聊天"
                isIconOnly
                size="sm"
                variant="ghost"
                icon={<X size={16} />}
                onClick={() => onRequirementModeChange(false)}
              />
            ) : null}
          </>
        }
        status={error ? { type: "error", message: error } : undefined}
        statusPosition="top"
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          void upload(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <AlertDialog
        isOpen={resetOpen}
        onOpenChange={setResetOpen}
        title="新建项目会话"
        description="当前项目聊天上下文将被清空，需求和任务不会删除。"
        actionLabel="新建会话"
        cancelLabel="取消"
        actionVariant="destructive"
        onAction={() => {
          setResetOpen(false);
          data.onProjectChatInputChange("");
          void data.onProjectChatReset();
        }}
      />
    </>
  );
}
