import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, {
  positionRequirementWorkbenchNodes,
  shouldVirtualizeCanvasNodes,
} from "./App";
import { buildOrbitNodes, OrbitNode } from "./canvas/orbitNodes";

class WebSocketMock {
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {}

  close() {}
}

const canvasResponse = {
  project: {
    id: "current",
    name: "demo",
    git_url: "",
    local_path: "D:\\work\\rust\\raccoon_agents_test",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
  active_requirement: null,
  queued_requirements: [],
  completed_requirements: [],
  token_usage: null,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("App", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // localStorage can be unavailable in restricted test environments.
    }
    vi.stubGlobal("WebSocket", WebSocketMock);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/project/current")) {
          return Promise.resolve(
            jsonResponse({
              project: canvasResponse.project,
              theme_pack: "neutral",
              theme_mode: "dark",
              publication_readiness: {
                ready: true,
                mode: "local",
                issues: [],
              },
            }),
          );
        }
        if (url.includes("/canvas"))
          return Promise.resolve(jsonResponse(canvasResponse));
        if (url.includes("/chat")) {
          return Promise.resolve(
            jsonResponse({
              project_id: "current",
              messages: [],
              running: false,
              error: null,
              updated_at: "2026-07-01T00:00:00Z",
            }),
          );
        }
        if (url.includes("/settings/basic")) {
          return Promise.resolve(
            jsonResponse({
              theme_pack: "neutral",
              theme_mode: "dark",
              host: "127.0.0.1",
              port: 3001,
              host_overridden: false,
              port_overridden: false,
              effective_host: "127.0.0.1",
              effective_port: 3001,
              restart_required: false,
              commit_mode: "pull_request",
            }),
          );
        }
        if (url.includes("/settings/models")) {
          return Promise.resolve(
            jsonResponse({
              models: [],
              settings: {
                low: { model_id: null, thinking_level: "low" },
                medium: { model_id: null, thinking_level: "medium" },
                high: { model_id: null, thinking_level: "high" },
              },
              rpc_status: "ready",
              rpc_error: null,
            }),
          );
        }
        if (url.includes("/git/status")) {
          return Promise.resolve(
            jsonResponse({
              branch: "main",
              head: "abc123",
              upstream: null,
              ahead: 0,
              behind: 0,
              branches: ["main"],
              remote_configured: false,
              write_blocked: false,
              blocked_reason: null,
              files: [],
            }),
          );
        }
        if (url.includes("/terminals"))
          return Promise.resolve(jsonResponse([]));
        if (url.includes("/terminal-access")) {
          return Promise.resolve(
            jsonResponse({
              required: false,
              authorized: true,
              expires_at: null,
            }),
          );
        }
        if (url.includes("/files")) return Promise.resolve(jsonResponse([]));
        return Promise.resolve(jsonResponse({}));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the current canvas shell with six fixed orbit nodes", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("项目对话")).toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "项目聊天输入" }),
      ).toBeInTheDocument();
      expect(screen.getByText("询问当前项目")).toBeInTheDocument();
    });

    const orbitNodes = buildOrbitNodes({
      activePanel: null,
      gitBranch: "main",
      modelRpcStatus: "ready",
      requirementCount: 0,
      terminalCount: 0,
      tokenTotal: 0,
      onOpen: vi.fn(),
    });
    expect(orbitNodes.map((node) => node.id)).toEqual([
      "orbit-settings",
      "orbit-terminal",
      "orbit-git",
      "orbit-tokens",
      "orbit-requirements",
      "orbit-files",
    ]);
    expect(
      screen.queryByLabelText("React Flow Mini Map"),
    ).not.toBeInTheDocument();

    const chatNode = screen.getByTestId("rf__node-requirement-chat");
    const settingsNode = screen.getByTestId("rf__node-orbit-settings");
    expect(chatNode).toHaveStyle({ pointerEvents: "all" });
    expect(settingsNode).toHaveStyle({ pointerEvents: "all" });
    expect(chatNode.querySelector(".node-card--requirement-chat")).toHaveClass(
      "nowheel",
    );
  });

  it("opens an orbit workbench from its interactive button", () => {
    const onOpen = vi.fn();
    const settings = buildOrbitNodes({
      activePanel: null,
      gitBranch: "main",
      modelRpcStatus: "ready",
      requirementCount: 0,
      terminalCount: 0,
      tokenTotal: 0,
      onOpen,
    })[0];

    render(
      <OrbitNode
        {...({ data: settings.data } as Parameters<typeof OrbitNode>[0])}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /设置/ }));
    expect(onOpen).toHaveBeenCalledWith("settings");
  });

  it("pre-renders all canvas nodes only during camera transitions", () => {
    expect(shouldVirtualizeCanvasNodes("shell")).toBe(true);
    expect(shouldVirtualizeCanvasNodes("content")).toBe(true);
    expect(shouldVirtualizeCanvasNodes("focusing")).toBe(false);
    expect(shouldVirtualizeCanvasNodes("closing")).toBe(false);
  });

  it("shifts only root nodes into the requirements workbench", () => {
    const requirements = {
      id: "requirements",
      position: { x: 960, y: 0 },
      data: {} as never,
    };
    const group = {
      id: "requirement-task-group-task-1",
      position: { x: 1870, y: 4 },
      data: {} as never,
    };
    const child = {
      id: "requirement-task-task-1",
      parentId: group.id,
      position: { x: 24, y: 96 },
      data: {} as never,
    };

    const positioned = positionRequirementWorkbenchNodes([
      requirements,
      group,
      child,
    ]);

    expect(positioned[0].position).toEqual({ x: 0, y: 20 });
    expect(positioned[1].position).toEqual({ x: 910, y: 4 });
    expect(positioned[2]).toBe(child);
    expect(positioned[2].position).toEqual({ x: 24, y: 96 });
  });
});
