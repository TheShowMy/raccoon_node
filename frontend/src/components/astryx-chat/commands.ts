export type ProjectChatCommand =
  | { type: "requirement"; description: string | null }
  | { type: "new-session" }
  | { type: "message" };

export function parseProjectChatCommand(input: string): ProjectChatCommand {
  const value = input.trim();
  const requirement = value.match(/^\/需求生成(?:\s+([\s\S]+))?$/);
  if (requirement) {
    return {
      type: "requirement",
      description: requirement[1]?.trim() || null,
    };
  }
  if (value === "/新建会话") return { type: "new-session" };
  return { type: "message" };
}
