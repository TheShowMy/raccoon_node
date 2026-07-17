import { useMemo } from "react";
import { SubCanvas } from "../shared/SubCanvas";
import { useFilesStore } from "../../store/filesStore";
import { DirectoryNode, PreviewNode, ResultsNode, SearchNode } from "./nodes";
import { projectFiles } from "./projection";

const nodeTypes = {
  file_dir: DirectoryNode,
  file_search: SearchNode,
  file_results: ResultsNode,
  file_preview: PreviewNode,
};

/** 文件工作台（FE-FILE-*）：目录 / 搜索 / 结果 / 预览节点 */
export function FilesWorkbench() {
  const selectedPath = useFilesStore((state) => state.selectedPath);
  const submittedQuery = useFilesStore((state) => state.submittedQuery);
  const projection = useMemo(
    () => projectFiles({ selectedPath, submittedQuery }),
    [selectedPath, submittedQuery],
  );
  return (
    <SubCanvas
      kind="files"
      nodeTypes={nodeTypes}
      projection={projection}
      ariaLabel="文件子画布"
    />
  );
}
