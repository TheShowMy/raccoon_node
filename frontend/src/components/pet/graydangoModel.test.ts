import { describe, expect, it } from "vitest";
import type { StartNodeData } from "../../types/api";
import {
  deriveGrayDangoPresentation,
  GRAYDANGO_DRAG_ANIMATIONS,
  grayDangoDirectionCell,
} from "./graydangoModel";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

function chatData(overrides: Partial<ChatData> = {}): ChatData {
  return {
    kind: "requirement-chat",
    project: { name: "repo", git_url: "", local_path: "/repo" },
    requirement: null,
    conversation: null,
    promptDismissed: false,
    busy: false,
    requirementOpeningId: null,
    error: null,
    streamEvents: [],
    projectChat: null,
    projectChatBusy: false,
    projectChatError: null,
    projectChatEvents: [],
    onSend: async () => true,
    onStartRequirement: async () => true,
    onProjectChatSend: async () => true,
    onProjectChatAbort: async () => {},
    onProjectChatReset: async () => true,
    onSubmitClarifications: async () => true,
    onConfirm: async () => {},
    onContinueEditing: () => {},
    onCancel: () => {},
    onAbandon: () => {},
    ...overrides,
  };
}

describe("deriveGrayDangoPresentation", () => {
  it("rests without a bubble while the project is idle", () => {
    expect(deriveGrayDangoPresentation(chatData())).toMatchObject({
      animation: "idle",
      row: 0,
      bubble: null,
    });
  });

  it("waits with the Codex-style confirmation bubble", () => {
    expect(
      deriveGrayDangoPresentation(
        chatData({ requirement: { status: "draft_ready" } as never }),
      ),
    ).toMatchObject({
      animation: "waiting",
      row: 6,
      bubble: "草案准备好了，等你确认",
    });
  });

  it("uses the focused-work row while chat is running", () => {
    expect(
      deriveGrayDangoPresentation(chatData({ projectChatBusy: true })),
    ).toMatchObject({ animation: "running", row: 7, bubble: "正在处理…" });
  });

  it("shows failures immediately", () => {
    expect(
      deriveGrayDangoPresentation(chatData({ projectChatError: "连接失败" })),
    ).toMatchObject({
      animation: "failed",
      row: 5,
      bubble: "连接失败",
      tone: "error",
    });
  });
});

describe("grayDangoDirectionCell", () => {
  it.each([
    [0, -100, { row: 9, column: 0 }],
    [100, 0, { row: 9, column: 4 }],
    [0, 100, { row: 10, column: 0 }],
    [-100, 0, { row: 10, column: 4 }],
  ])("maps pointer vector (%s, %s) to the current atlas", (x, y, expected) => {
    expect(grayDangoDirectionCell(x, y, 10)).toEqual(expected);
  });

  it("uses idle inside the pointer deadzone", () => {
    expect(grayDangoDirectionCell(2, 2, 10)).toBeNull();
  });
});

describe("GrayDango drag animations", () => {
  it("uses the existing directional movement rows", () => {
    expect(GRAYDANGO_DRAG_ANIMATIONS).toEqual({
      right: { row: 1, frames: 8 },
      left: { row: 2, frames: 8 },
    });
  });
});
