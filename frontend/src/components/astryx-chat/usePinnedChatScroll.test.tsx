import { useLayoutEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePinnedChatScroll } from "./usePinnedChatScroll";

function Harness({ revision }: { revision: number }) {
  const scroll = usePinnedChatScroll();
  useLayoutEffect(() => {
    scroll.onContentChange();
  }, [revision, scroll.onContentChange]);

  return (
    <div
      ref={scroll.scrollRef}
      data-testid="scroll-host"
      onScroll={scroll.onScroll}
      onWheel={scroll.onWheel}
      onTouchMove={scroll.onTouchMove}
    />
  );
}

describe("usePinnedChatScroll", () => {
  it("follows growth until the user scrolls up and relocks at the bottom", async () => {
    let scrollHeight = 1_000;
    const view = render(<Harness revision={0} />);
    const host = screen.getByTestId("scroll-host");
    Object.defineProperties(host, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    host.scrollTop = 600;
    fireEvent.scroll(host);
    scrollHeight = 1_200;
    view.rerender(<Harness revision={1} />);
    await waitFor(() => expect(host.scrollTop).toBe(800));

    fireEvent.wheel(host, { deltaY: -40 });
    host.scrollTop = 500;
    fireEvent.scroll(host);
    scrollHeight = 1_400;
    view.rerender(<Harness revision={2} />);
    await waitFor(() => expect(host.scrollTop).toBe(500));

    host.scrollTop = 1_000;
    fireEvent.scroll(host);
    scrollHeight = 1_600;
    view.rerender(<Harness revision={3} />);
    await waitFor(() => expect(host.scrollTop).toBe(1_200));
  });
});
