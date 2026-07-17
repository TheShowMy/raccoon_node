import { describe, expect, it } from "vitest";
import { groupChanges } from "./git";
import type { GitChange } from "./types";

const changes: GitChange[] = [
  { path: "b.ts", status: "staged", diff: null },
  { path: "a.ts", status: "unstaged", diff: null },
  { path: "c.md", status: "untracked", diff: null },
  { path: "d.rs", status: "conflicted", diff: null },
  { path: "a.md", status: "staged", diff: null },
];

describe("Git 变更分组（FE-GIT-002）", () => {
  it("按 conflicted → staged → unstaged → untracked 顺序分组", () => {
    const groups = groupChanges(changes);
    expect(groups.map((group) => group.status)).toEqual([
      "conflicted",
      "staged",
      "unstaged",
      "untracked",
    ]);
  });

  it("组内按路径排序", () => {
    const staged = groupChanges(changes).find(
      (group) => group.status === "staged",
    );
    expect(staged?.changes.map((change) => change.path)).toEqual([
      "a.md",
      "b.ts",
    ]);
  });

  it("空组被过滤", () => {
    const groups = groupChanges([changes[0]]);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe("staged");
  });
});
