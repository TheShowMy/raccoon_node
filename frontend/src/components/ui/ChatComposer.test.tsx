// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChatComposer from "./ChatComposer";

function setCursorAtEnd(element: HTMLElement) {
  element.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const textNode = element.firstChild;
  if (textNode?.nodeType === Node.TEXT_NODE) {
    range.setStart(textNode, textNode.textContent?.length ?? 0);
  } else {
    range.selectNodeContents(element);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

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

    const input = screen.getByLabelText("输入");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit while composing or when sending is disabled", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ChatComposer
        value="问题"
        disabled={false}
        canSend
        placeholder="输入"
        onChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.keyDown(screen.getByLabelText("输入"), {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(
      <ChatComposer
        value="   "
        disabled={false}
        canSend={false}
        placeholder="输入"
        onChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("输入"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("selects and dismisses the fixed requirement slash command by keyboard", async () => {
    const onSubmit = vi.fn();
    const onGenerate = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(
      <ChatComposer
        value="/生成"
        disabled={false}
        canSend
        placeholder="输入"
        onChange={onChange}
        onSubmit={onSubmit}
        onGenerateRequirementSummary={onGenerate}
      />,
    );
    const input = screen.getByLabelText("输入");
    setCursorAtEnd(input);
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "/生成需求说明" }),
      ).toBeInTheDocument(),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("");
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(
      <ChatComposer
        value="/生"
        disabled={false}
        canSend
        placeholder="输入"
        onChange={onChange}
        onSubmit={onSubmit}
        onGenerateRequirementSummary={onGenerate}
      />,
    );
    setCursorAtEnd(input);
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: "/生成需求说明" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});
