// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getProjectFileContent } from "../../api/client";
import DocumentPreview from "./DocumentPreview";

vi.mock("../../api/client", () => ({
  getProjectFileContent: vi.fn(),
}));

describe("DocumentPreview", () => {
  it("loads a referenced markdown file only when expanded", async () => {
    vi.mocked(getProjectFileContent).mockResolvedValue({
      path: "README.md",
      content: "# 项目说明",
      truncated: false,
    });
    render(<DocumentPreview projectId="current" path="README.md" />);

    expect(getProjectFileContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /README.md/ }));

    expect(
      await screen.findByRole("heading", { name: "项目说明" }),
    ).toBeInTheDocument();
    expect(getProjectFileContent).toHaveBeenCalledWith("current", "README.md");
  });
});
