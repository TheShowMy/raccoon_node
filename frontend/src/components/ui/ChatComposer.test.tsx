// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChatComposer from "./ChatComposer";

describe("ChatComposer", () => {
  it("submits on Enter and keeps Shift+Enter for new lines", () => {
    const onSubmit = vi.fn();
    render(
      <ChatComposer
        value="问题"
        disabled={false}
        canSend
        placeholder="输入"
        onChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByPlaceholderText("输入");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit while composing or when sending is disabled", () => {
    const onSubmit = vi.fn();
    const view = render(
      <ChatComposer
        value="问题"
        disabled={false}
        canSend
        placeholder="输入"
        onChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText("输入"), {
      key: "Enter",
      keyCode: 229,
    });
    expect(onSubmit).not.toHaveBeenCalled();

    view.rerender(
      <ChatComposer
        value="   "
        disabled={false}
        canSend={false}
        placeholder="输入"
        onChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText("输入"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
