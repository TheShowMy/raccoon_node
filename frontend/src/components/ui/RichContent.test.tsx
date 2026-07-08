// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RichContent from "./RichContent";

describe("RichContent", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders GFM without executing raw HTML", () => {
    const { container } = render(
      <RichContent
        content={
          "| 名称 | 状态 |\n| --- | --- |\n| API | 完成 |\n\n- [x] 测试\n\n<script>alert(1)</script>"
        }
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(container.querySelector("script")).toBeNull();
  });

  it("copies fenced code", async () => {
    render(<RichContent content={"```rust\nfn main() {}\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "fn main() {}",
      ),
    );
  });
});
