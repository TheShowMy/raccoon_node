// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChatMessageBubble from "./ChatMessageBubble";

describe("ChatMessageBubble", () => {
  it("renders content and children", () => {
    render(
      <ChatMessageBubble
        role="assistant"
        content="answer text"
        createdAt="2026-06-25T00:00:00Z"
      >
        <div data-testid="process-card">process</div>
      </ChatMessageBubble>,
    );

    expect(screen.getByText("answer text")).toBeInTheDocument();
    expect(screen.getByTestId("process-card")).toBeInTheDocument();
  });

  it("renders children before content", () => {
    render(
      <ChatMessageBubble
        role="assistant"
        content="answer text"
        createdAt="2026-06-25T00:00:00Z"
      >
        <div data-testid="process-card">process</div>
      </ChatMessageBubble>,
    );

    const body = screen.getByText("answer text").parentElement;
    const children = screen.getByTestId("process-card")
      .parentElement as HTMLElement;
    expect(body).toContainElement(children);
    expect(
      children.compareDocumentPosition(screen.getByText("answer text")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
