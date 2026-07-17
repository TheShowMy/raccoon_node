import { beforeEach, describe, expect, it } from "vitest";
import {
  emptyDraft,
  MAX_FILE_REFS,
  MAX_IMAGES,
  useComposerStore,
} from "./composerStore";

describe("Composer 草稿引用与附件（FE-CHAT-001、FE-FILE-003）", () => {
  beforeEach(() => {
    useComposerStore.setState({ drafts: {} });
  });

  it("引用到 Composer：加入草稿不发送、去重、上限 8", () => {
    const store = useComposerStore.getState();
    expect(store.addFileRef("b-main", "src/main.rs")).toBe(true);
    expect(store.addFileRef("b-main", "src/main.rs")).toBe(true); // 去重幂等
    expect(useComposerStore.getState().drafts["b-main"].file_refs).toEqual([
      "src/main.rs",
    ]);
    for (let i = 1; i < MAX_FILE_REFS; i += 1) {
      expect(store.addFileRef("b-main", `src/f${i}.rs`)).toBe(true);
    }
    expect(store.addFileRef("b-main", "src/overflow.rs")).toBe(false);
    expect(useComposerStore.getState().drafts["b-main"].file_refs).toHaveLength(
      MAX_FILE_REFS,
    );
  });

  it("图片附件占地上限 3，可移除", () => {
    const store = useComposerStore.getState();
    for (let i = 0; i < MAX_IMAGES; i += 1) {
      expect(store.addImage("b-main", `图片-${i}.png`)).toBe(true);
    }
    expect(store.addImage("b-main", "图片-x.png")).toBe(false);
    store.removeImage("b-main", "图片-0.png");
    expect(useComposerStore.getState().drafts["b-main"].images).toEqual([
      "图片-1.png",
      "图片-2.png",
    ]);
  });

  it("发送后 clearDraft 清空引用与附件", () => {
    const store = useComposerStore.getState();
    store.addFileRef("b-main", "README.md");
    store.addImage("b-main", "图片-1.png");
    store.clearDraft("b-main");
    expect(useComposerStore.getState().drafts["b-main"]).toBeUndefined();
    expect(emptyDraft.file_refs).toEqual([]);
  });
});
