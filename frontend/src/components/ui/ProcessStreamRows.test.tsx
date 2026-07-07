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

  it("expands a running thinking row and hides its loader", () => {
    render(<ProcessStreamRows rows={[thinkingRow("running", "step 1")]} />);

    expect(screen.getByText("step 1")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.querySelector(".rq-spin")).not.toBeInTheDocument();
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

    expect(document.querySelector(".rq-spin")).toBeInTheDocument();
  });
});
