import { describe, expect, it } from "vitest";
import { parseProjectChatCommand } from "./commands";

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
});
