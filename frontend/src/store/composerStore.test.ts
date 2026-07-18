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

  it("图片附件校验类型、单张和数量上限，并可移除", () => {
    const store = useComposerStore.getState();
    const images = Array.from(
      { length: MAX_IMAGES },
      (_, index) =>
        new File(["png"], `图片-${index}.png`, { type: "image/png" }),
    );
    expect(store.addImages("b-main", images)).toEqual({
      added: MAX_IMAGES,
      error: null,
    });
    expect(
      store.addImages("b-main", [
        new File(["more"], "图片-x.png", { type: "image/png" }),
      ]),
    ).toEqual({ added: 0, error: "最多添加 3 张图片" });
    const firstId = useComposerStore.getState().drafts["b-main"].images[0].id;
    store.removeImage("b-main", firstId);
    expect(
      useComposerStore
        .getState()
        .drafts["b-main"].images.map((image) => image.name),
    ).toEqual(["图片-1.png", "图片-2.png"]);
  });

  it("拒绝非图片和超过 5 MiB 的图片", () => {
    const store = useComposerStore.getState();
    expect(
      store.addImages("b-main", [
        new File(["text"], "notes.txt", { type: "text/plain" }),
      ]),
    ).toEqual({ added: 0, error: "notes.txt 不是可识别的图片" });
    expect(
      store.addImages("b-main", [
        new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", {
          type: "image/png",
        }),
      ]),
    ).toEqual({ added: 0, error: "large.png 超过单张 5 MiB 限制" });
  });

  it("发送后 clearDraft 清空引用与附件", () => {
    const store = useComposerStore.getState();
    store.addFileRef("b-main", "README.md");
    store.addImages("b-main", [
      new File(["png"], "图片-1.png", { type: "image/png" }),
    ]);
    store.clearDraft("b-main");
    expect(useComposerStore.getState().drafts["b-main"]).toBeUndefined();
    expect(emptyDraft.file_refs).toEqual([]);
  });
});
