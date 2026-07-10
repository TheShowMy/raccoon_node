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

  it("blocks dangerous URL schemes in links", () => {
    render(
      <RichContent
        content={
          "[safe](https://example.com) [js](javascript:alert(1)) [data](data:text/html,<script>alert(1)</script>)"
        }
      />,
    );

    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(screen.queryByRole("link", { name: "js" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "data" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("js")).toBeInTheDocument();
    expect(screen.getByText("data")).toBeInTheDocument();
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
