// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AnchoredScroll from "./AnchoredScroll";

describe("AnchoredScroll", () => {
  it("does not force the viewport to the bottom after the user scrolls up", async () => {
    const view = render(
      <AnchoredScroll className="viewport" version={1}>
        第一条
      </AnchoredScroll>,
    );
    const viewport = view.container.querySelector(".viewport") as HTMLElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);

    view.rerender(
      <AnchoredScroll className="viewport" version={2}>
        第二条
      </AnchoredScroll>,
    );

    expect(
      await screen.findByRole("button", { name: "有新消息" }),
    ).toBeInTheDocument();
    expect(viewport.scrollTop).toBe(200);
    fireEvent.click(screen.getByRole("button", { name: "有新消息" }));
    expect(viewport.scrollTop).toBe(1000);
  });
});
