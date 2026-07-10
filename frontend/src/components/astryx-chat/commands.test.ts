import { describe, expect, it } from "vitest";
import { parseProjectChatCommand, projectChatCommandToken } from "./commands";

describe("parseProjectChatCommand", () => {
  it("recognizes requirement preparation and inline descriptions", () => {
    expect(parseProjectChatCommand("/需求生成")).toEqual({
      type: "requirement",
      description: null,
    });
    expect(parseProjectChatCommand("/需求生成  重写登录流程 ")).toEqual({
      type: "requirement",
      description: "重写登录流程",
    });
  });

  it("recognizes new sessions without treating normal text as a command", () => {
    expect(parseProjectChatCommand("/新建会话")).toEqual({
      type: "new-session",
    });
    expect(parseProjectChatCommand("解释 /需求生成")).toEqual({
      type: "message",
    });
  });

  it("keeps requirement selection as an editable inline command token", () => {
    expect(
      projectChatCommandToken({ id: "requirement", label: "需求生成" }),
    ).toEqual({
      value: "/需求生成 ",
      label: "/需求生成",
      variant: "yellow",
    });
  });
});
