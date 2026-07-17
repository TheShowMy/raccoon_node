import type { Edge } from "@xyflow/react";
import type { SubFlowNode, SubProjection } from "../shared/SubCanvas";

/**
 * 文件工作台投影（FE-FILE-001/002，纯函数）：
 * 目录节点是锚点；搜索产生查询节点 + 结果节点；预览节点独立于目录状态。
 */

export const filesNodeId = {
  dir: () => "file-dir",
  search: () => "file-search",
  results: () => "file-results",
  preview: () => "file-preview",
};

export type FilesProjectionInput = {
  selectedPath: string | null;
  submittedQuery: string | null;
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

function edge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: "out-r",
    targetHandle: "in-l",
    className: "de-chain",
    selectable: false,
    focusable: false,
  };
}

export function projectFiles(input: FilesProjectionInput): SubProjection {
  const nodes: SubFlowNode[] = [
    node(filesNodeId.dir(), "file_dir", 0, 0),
    node(filesNodeId.search(), "file_search", 400, 0),
  ];
  const edges: Edge[] = [
    edge("e-dir-search", filesNodeId.dir(), filesNodeId.search()),
  ];

  if (input.submittedQuery) {
    nodes.push(
      node(filesNodeId.results(), "file_results", 400, 240, {
        query: input.submittedQuery,
      }),
    );
    edges.push(
      edge("e-search-results", filesNodeId.search(), filesNodeId.results()),
    );
  }
  if (input.selectedPath) {
    nodes.push(
      node(filesNodeId.preview(), "file_preview", 800, 0, {
        path: input.selectedPath,
      }),
    );
    edges.push(edge("e-dir-preview", filesNodeId.dir(), filesNodeId.preview()));
    if (input.submittedQuery) {
      edges.push(
        edge("e-results-preview", filesNodeId.results(), filesNodeId.preview()),
      );
    }
  }
  return { nodes, edges };
}
