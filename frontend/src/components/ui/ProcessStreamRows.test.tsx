// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ProcessStreamRows from "./ProcessStreamRows";
import type { ProcessRow } from "../../utils/format";

function thinkingRow(
  status: ProcessRow["status"],
  content: string,
): ProcessRow {
  return {
    id: "thinking-0",
    type: "thinking",
    content,
    status,
  };
}

function toolRow(status: ProcessRow["status"]): ProcessRow {
  return {
    id: "tool-1",
    type: "tool",
    toolCallId: "tool-1",
    toolName: "read",
    input: { path: "src/main.rs" },
    output: "src/main.rs",
    preview: "src/main.rs",
    status,
  };
}

describe("ProcessStreamRows", () => {
  it("does not render a synthetic pending row while running", () => {
    render(<ProcessStreamRows rows={[]} running={true} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a running thinking row with Astryx loading state", () => {
    render(<ProcessStreamRows rows={[thinkingRow("running", "step 1")]} />);

    expect(
      screen.getByRole("button", { name: /Thinking/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("step 1")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("keeps a completed thinking row collapsed by default", () => {
    render(<ProcessStreamRows rows={[thinkingRow("done", "step 1")]} />);

    expect(screen.queryByText("step 1")).not.toBeInTheDocument();
  });

  it("toggles a completed thinking row open on click", () => {
    render(<ProcessStreamRows rows={[thinkingRow("done", "step 1")]} />);

    fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("step 1")).toBeInTheDocument();
  });

  it("shows a loader on a running tool row", () => {
    render(<ProcessStreamRows rows={[toolRow("running")]} />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });
});
