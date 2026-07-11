import { describe, expect, it, vi } from "vitest";
import {
  buildOrbitNodes,
  CHAT_NODE_BOUNDS,
  ORBIT_NODE_SIZE,
  WORKSPACE_PANEL_SIZE,
  workspacePanelPosition,
} from "./orbitNodes";

describe("workspacePanelPosition", () => {
  it("places every workspace panel beyond its satellite on the chat ray", () => {
    const nodes = buildOrbitNodes({
      activePanel: null,
      gitBranch: "main",
      modelRpcStatus: "ready",
      requirementCount: 0,
      terminalCount: 0,
      tokenContextPercent: 0,
      onOpen: vi.fn(),
      canvasSize: { width: 1280, height: 720 },
    });
    const chatCenter = {
      x: CHAT_NODE_BOUNDS.x + CHAT_NODE_BOUNDS.width / 2,
      y: CHAT_NODE_BOUNDS.y + CHAT_NODE_BOUNDS.height / 2,
    };

    for (const node of nodes) {
      const panel = workspacePanelPosition(node);
      const satelliteCenter = {
        x: node.position.x + ORBIT_NODE_SIZE.width / 2,
        y: node.position.y + ORBIT_NODE_SIZE.height / 2,
      };
      const panelCenter = {
        x: panel.x + WORKSPACE_PANEL_SIZE.width / 2,
        y: panel.y + WORKSPACE_PANEL_SIZE.height / 2,
      };
      const ray = {
        x: satelliteCenter.x - chatCenter.x,
        y: satelliteCenter.y - chatCenter.y,
      };
      const extension = {
        x: panelCenter.x - satelliteCenter.x,
        y: panelCenter.y - satelliteCenter.y,
      };

      expect(ray.x * extension.y - ray.y * extension.x).toBeCloseTo(0);
      expect(ray.x * extension.x + ray.y * extension.y).toBeGreaterThan(0);
      expect(
        panel.x < node.position.x + ORBIT_NODE_SIZE.width &&
          panel.x + WORKSPACE_PANEL_SIZE.width > node.position.x &&
          panel.y < node.position.y + ORBIT_NODE_SIZE.height &&
          panel.y + WORKSPACE_PANEL_SIZE.height > node.position.y,
      ).toBe(false);
    }
  });

  it("keeps the legacy right-side position until an orbit node is available", () => {
    expect(workspacePanelPosition(null)).toEqual({ x: 1540, y: 0 });
  });
});
