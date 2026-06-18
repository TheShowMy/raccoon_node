import { describe, expect, it } from "vitest";
import { formatDate, shortenGitUrl } from "../utils/format";

describe("format utilities", () => {
  it("strips protocol from Git URLs", () => {
    expect(shortenGitUrl("https://github.com/example/repo.git")).toBe(
      "github.com/example/repo.git",
    );
    expect(shortenGitUrl("git@github.com:example/repo.git")).toBe(
      "github.com/example/repo.git",
    );
  });

  it("formats ISO dates", () => {
    const date = new Date("2026-06-18T10:30:00Z").toISOString();
    expect(formatDate(date)).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
  });
});
