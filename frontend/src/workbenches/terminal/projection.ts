import type { Edge } from "@xyflow/react";
import type { TerminalSession, WorkbenchAction } from "../../api/types";
import type { SubFlowNode, SubProjection } from "../shared/SubCanvas";

/** 终端工作台投影（FE-TERM-001：每个 PTY 是独立会话节点） */

export const terminalNodeId = {
  launcher: () => "term-launcher",
  session: (sessionId: string) => `term:${sessionId}`,
  actionConfirmation: (actionId: string) => `term-action:${actionId}`,
  actionResult: (actionId: string) => `term-action-result:${actionId}`,
};

export type TerminalProjectionInput = {
  sessions: TerminalSession[];
  actions: WorkbenchAction[];
};

function node(
  id: string,
  type: string,
  x: number,
  y: number,
  data: Record<string, unknown> = {},
): SubFlowNode {
  return {
    id,
    type,
    position: { x, y },
    data,
    draggable: false,
    selectable: false,
    deletable: false,
  };
}

function edge(
  source: string,
  target: string,
  kind: "chain" | "blocked" = "chain",
): Edge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle: "out-r",
    targetHandle: "in-l",
    className: `de-${kind}`,
    selectable: false,
    focusable: false,
  };
}

const SESSION_W = 540;
const SESSION_H = 400;

export function projectTerminal(input: TerminalProjectionInput): SubProjection {
  const nodes: SubFlowNode[] = [
    node(terminalNodeId.launcher(), "term_launcher", 0, 0),
  ];
  const edges: Edge[] = [];
  const sorted = [...input.sessions].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const positions = new Map<string, { x: number; y: number }>();
  sorted.forEach((session, index) => {
    const x = (index % 2) * (SESSION_W + 40);
    const y = 300 + Math.floor(index / 2) * (SESSION_H + 40);
    positions.set(session.id, { x, y });
    nodes.push(
      node(terminalNodeId.session(session.id), "term_session", x, y, {
        session,
      }),
    );
    edges.push(
      edge(terminalNodeId.launcher(), terminalNodeId.session(session.id)),
    );
  });

  const terminalActions = input.actions
    .filter((action) => action.kind === "terminal_close")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-3);
  terminalActions.forEach((action) => {
    const base = positions.get(action.payload.session_id) ?? { x: 0, y: 300 };
    if (action.state === "awaiting") {
      const id = terminalNodeId.actionConfirmation(action.id);
      nodes.push(
        node(id, "term_action_confirmation", base.x + 60, base.y + SESSION_H, {
          action,
        }),
      );
      const source = terminalNodeId.session(action.payload.session_id);
      edges.push(edge(source, id, "blocked"));
    } else if (action.result) {
      const id = terminalNodeId.actionResult(action.id);
      nodes.push(
        node(id, "term_action_result", base.x + 60, base.y + SESSION_H, {
          action,
        }),
      );
    }
  });

  return { nodes, edges };
}
