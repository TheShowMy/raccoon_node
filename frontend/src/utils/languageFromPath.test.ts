import { describe, expect, it } from "vitest";
import { getLanguageFromPath } from "./languageFromPath";

describe("getLanguageFromPath", () => {
  it.each([
    ["src/main.rs", "plaintext"],
    ["src/App.tsx", "tsx"],
    ["src/index.ts", "typescript"],
    ["lib/index.js", "javascript"],
    ["styles/app.css", "css"],
    ["docs/readme.md", "markdown"],
    ["config.yaml", "yaml"],
    ["script.sh", "bash"],
    ["app.py", "python"],
    ["data.json", "json"],
    ["Makefile", "plaintext"],
    ["no-extension", "plaintext"],
  ])("maps %s to %s", (path, expected) => {
    expect(getLanguageFromPath(path)).toBe(expected);
  });
});
