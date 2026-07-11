import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FilesWorkbench from "./FilesWorkbench";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("FilesWorkbench", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads root tree and renders scrollable areas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/files/tree?path=")) {
          return Promise.resolve(
            jsonResponse([
              { name: "src", path: "src", kind: "directory" },
              { name: "README.md", path: "README.md", kind: "file" },
            ]),
          );
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );

    render(<FilesWorkbench projectId="current" />);

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });
    expect(screen.getByText("README.md")).toBeInTheDocument();

    const scrollables = document.querySelectorAll(".nodrag.nowheel");
    expect(scrollables.length).toBeGreaterThanOrEqual(2);
  });

  it("expands directory by clicking the whole row and lazily loads children", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/files/tree?path=src")) {
          return Promise.resolve(
            jsonResponse([
              { name: "main.rs", path: "src/main.rs", kind: "file" },
            ]),
          );
        }
        if (url.includes("/files/tree?path=")) {
          return Promise.resolve(
            jsonResponse([{ name: "src", path: "src", kind: "directory" }]),
          );
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );

    render(<FilesWorkbench projectId="current" />);

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("src"));

    await waitFor(() => {
      expect(screen.getByText("main.rs")).toBeInTheDocument();
    });
  });

  it("opens a file and shows a closeable tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/files/content?path=")) {
          return Promise.resolve(
            jsonResponse({
              path: "README.md",
              content: "# Hello",
              truncated: false,
            }),
          );
        }
        if (url.includes("/files/tree?path=")) {
          return Promise.resolve(
            jsonResponse([
              { name: "README.md", path: "README.md", kind: "file" },
            ]),
          );
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );

    render(<FilesWorkbench projectId="current" />);

    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("README.md"));

    await waitFor(() => {
      expect(screen.getByLabelText(/关闭 README\.md/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/关闭 README\.md/));

    await waitFor(() => {
      expect(
        screen.queryByLabelText(/关闭 README\.md/),
      ).not.toBeInTheDocument();
    });
  });

  it("shows a truncation warning for large files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/files/content?path=")) {
          return Promise.resolve(
            jsonResponse({
              path: "big.log",
              content: "lots of text",
              truncated: true,
            }),
          );
        }
        if (url.includes("/files/tree?path=")) {
          return Promise.resolve(
            jsonResponse([{ name: "big.log", path: "big.log", kind: "file" }]),
          );
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );

    render(<FilesWorkbench projectId="current" />);

    await waitFor(() => {
      expect(screen.getByText("big.log")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("big.log"));

    await waitFor(() => {
      expect(screen.getByText(/文件过大/)).toBeInTheDocument();
    });
  });

  it("searches files with debounce", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/files?search=query")) {
          return Promise.resolve(jsonResponse([{ path: "src/query.ts" }]));
        }
        if (url.includes("/files/tree?path=")) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );

    render(<FilesWorkbench projectId="current" />);

    const search = await waitFor(() => {
      return screen.getByPlaceholderText("搜索仓库文件");
    });

    fireEvent.change(search, { target: { value: "query" } });

    await waitFor(
      () => {
        expect(screen.getByText("src/query.ts")).toBeInTheDocument();
      },
      { timeout: 1000 },
    );
  });
});
