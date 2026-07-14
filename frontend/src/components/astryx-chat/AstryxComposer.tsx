import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatSendButton,
  type ChatComposerInputHandle,
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
import { Paperclip } from "lucide-react";
import { getProjectFiles, uploadProjectAttachment } from "../../api/client";
import type {
  FileReference,
  ImageAttachment,
  StartNodeData,
} from "../../types/api";
import RequirementPrompt from "./RequirementPrompt";
import { parseProjectChatCommand, projectChatCommandToken } from "./commands";

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

type ComposerDraft = {
  value: string;
  references: FileReference[];
  images: ImageAttachment[];
};

type ComposerDraftState = Record<string, ComposerDraft>;

type ComposerDraftAction =
  | { type: "reset" }
  | { type: "clear"; scope: string }
  | {
      type: "update";
      scope: string;
      patch: Partial<ComposerDraft>;
    };

const EMPTY_DRAFT: ComposerDraft = {
  value: "",
  references: [],
  images: [],
};

function composerDraftReducer(
  state: ComposerDraftState,
  action: ComposerDraftAction,
): ComposerDraftState {
  if (action.type === "reset") return {};
  if (action.type === "clear") {
    if (!(action.scope in state)) return state;
    const next = { ...state };
    delete next[action.scope];
    return next;
  }
  return {
    ...state,
    [action.scope]: {
      ...(state[action.scope] ?? EMPTY_DRAFT),
      ...action.patch,
    },
  };
}

export default function AstryxComposer({
  data,
  requirementMode,
  onContentChange,
}: {
  data: ChatData;
  requirementMode: boolean;
  onContentChange: () => void;
}) {
  const [files, setFiles] = useState<FileReference[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [inputRevision, setInputRevision] = useState(0);
  const [drafts, dispatchDraft] = useReducer(composerDraftReducer, {});
  const inputRef = useRef<HTMLInputElement>(null);
  const inputHandleRef = useRef<ChatComposerInputHandle>(null);
  const promptPreviouslyVisible = useRef(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void getProjectFiles("", controller.signal)
      .then(setFiles)
      .catch(() => setFiles([]));
    return () => controller.abort();
  }, [data.project.local_path]);

  useEffect(() => {
    dispatchDraft({ type: "reset" });
  }, [data.project.local_path]);

  const draftScope = requirementMode
    ? `requirement:${data.requirement?.id ?? data.requirementOpeningId ?? "opening"}`
    : "project";
  const draft = drafts[draftScope] ?? EMPTY_DRAFT;
  const { value, references, images } = draft;
  const updateDraft = (patch: Partial<ComposerDraft>) =>
    dispatchDraft({ type: "update", scope: draftScope, patch });
  const setReferences = (next: FileReference[]) =>
    updateDraft({ references: next });
  const setImages = (next: ImageAttachment[]) => updateDraft({ images: next });
  const setValue = (next: string) => updateDraft({ value: next });
  const clearDraft = () => {
    dispatchDraft({ type: "clear", scope: draftScope });
    setInputRevision((current) => current + 1);
  };
  const promptVisible = Boolean(
    requirementMode && data.conversation?.prompt && !data.promptDismissed,
  );

  useEffect(() => {
    onContentChange();
  }, [data.conversation?.prompt, data.promptDismissed, onContentChange]);

  useEffect(() => {
    if (promptPreviouslyVisible.current && !promptVisible && requirementMode) {
      requestAnimationFrame(() => inputHandleRef.current?.focus());
    }
    promptPreviouslyVisible.current = promptVisible;
  }, [promptVisible, requirementMode]);

  const fileSource = useMemo(
    () =>
      createStaticSource(
        files.map((file) => ({ id: file.path, label: file.path })),
      ),
    [files],
  );
  const commandSource = useMemo(() => createStaticSource(COMMANDS), []);

  const handleValueChange = (nextValue: string) => {
    if (submittingRef.current && nextValue === "") return;
    if (nextValue.trim() !== "/需求生成") setCommandError(null);
    setValue(nextValue);
  };

  const triggers = useMemo<ChatComposerTrigger[]>(() => {
    const fileTrigger: ChatComposerTrigger = {
      character: "@",
      searchSource: fileSource,
      onSelect: (item) => {
        setReferences(appendUniqueReference(references, item.id));
        return { value: `@${item.id}`, label: item.label, variant: "blue" };
      },
    };
    if (requirementMode) return [fileTrigger];
    const commandTrigger: ChatComposerTrigger = {
      character: "/",
      searchSource: commandSource,
      onSelect: (item) => {
        if (item.id === "new-session") {
          setResetOpen(true);
        }
        return projectChatCommandToken(item);
      },
    };
    return [fileTrigger, commandTrigger];
  }, [commandSource, data, fileSource, references, requirementMode]);

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
        uploaded.push(await uploadProjectAttachment(file));
      }
      setImages([...images, ...uploaded]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const submit = async (submitted: string) => {
    const message = submitted.trim();
    if (!message) return;
    submittingRef.current = true;
    try {
      if (!requirementMode) {
        const command = parseProjectChatCommand(message);
        if (command.type === "requirement") {
          setCommandError(null);
          const accepted = await data.onStartRequirement(
            command.description ?? "",
            {
              references,
              images,
            },
          );
          if (accepted) clearDraft();
          return;
        }
        if (command.type === "new-session") {
          setResetOpen(true);
          return;
        }
        const accepted = await data.onProjectChatSend({
          message,
          references,
          images,
        });
        if (accepted) clearDraft();
        return;
      }
      const accepted = await data.onSend({ message, references, images });
      if (accepted) clearDraft();
    } finally {
      setInputRevision((current) => current + 1);
      queueMicrotask(() => {
        submittingRef.current = false;
      });
    }
  };

  const attachmentCount = references.length + images.length;
  const attachmentDrawer = attachmentCount ? (
    <ChatComposerDrawer
      count={attachmentCount}
      label="上下文附件"
      defaultIsCollapsed={false}
    >
      <VStack gap={3} width="100%">
        {images.length ? (
          <Carousel gap={1}>
            {images.map((image) => (
              <Thumbnail
                key={image.path}
                src={`/api/attachments/${encodeURIComponent(image.path)}`}
                alt={image.name}
                label={image.name}
                onRemove={() =>
                  setImages(images.filter((item) => item.path !== image.path))
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
                  setReferences(
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
  const promptPanel = promptVisible ? (
    <RequirementPrompt data={data} />
  ) : undefined;
  const drawer =
    promptPanel || attachmentDrawer ? (
      <VStack gap={1} width="100%">
        {promptPanel}
        {attachmentDrawer}
      </VStack>
    ) : undefined;

  const running = requirementMode
    ? Boolean(
        data.busy ||
        data.conversation?.running ||
        data.requirement?.status === "analyzing",
      )
    : Boolean(data.projectChatBusy || data.projectChat?.running);
  const transitionPending = Boolean(
    data.requirementOpeningId && !data.requirement,
  );
  const composerDisabled =
    promptVisible || uploading || running || transitionPending;
  const error =
    commandError ??
    attachmentError ??
    (requirementMode ? data.error : (data.error ?? data.projectChatError));
  const status = error
    ? { type: "error" as const, message: error }
    : transitionPending
      ? { type: "warning" as const, message: "正在打开需求分支" }
      : undefined;
  const stop = () =>
    void (requirementMode ? data.onCancel() : data.onProjectChatAbort());

  return (
    <>
      <ChatComposer
        value={value}
        onChange={handleValueChange}
        onSubmit={(submitted) => void submit(submitted)}
        onStop={stop}
        isStopShown={running}
        density="balanced"
        placeholder={
          requirementMode ? "描述或补充需求" : "询问项目，输入 / 选择命令"
        }
        drawer={drawer}
        sendButton={<ChatSendButton isDisabled={composerDisabled} />}
        input={
          <ChatComposerInput
            key={inputRevision}
            handleRef={inputHandleRef}
            value={value}
            onChange={handleValueChange}
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
              isDisabled={composerDisabled}
              onClick={() => inputRef.current?.click()}
            />
          </>
        }
        status={status}
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
          void data.onProjectChatReset().then((accepted) => {
            if (accepted) clearDraft();
          });
        }}
      />
    </>
  );
}
