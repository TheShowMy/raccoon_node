import { useFilesStore } from "../../store/filesStore";
import {
  ToolWorkbench,
  WorkbenchPane,
  WorkbenchTabs,
  WorkbenchToolbar,
} from "../shared/ToolWorkbench";
import { DirectoryContent, PreviewContent, SearchContent } from "./nodes";

/** 文件工作台（FE-FILE-*）：资源管理器 + 文件预览连续页面。 */
export function FilesWorkbench() {
  const selectedPath = useFilesStore((state) => state.selectedPath);
  const sidebarMode = useFilesStore((state) => state.sidebarMode);
  const compactView = useFilesStore((state) => state.compactView);
  return (
    <ToolWorkbench className="files-workbench" ariaLabel="文件工具工作区">
      <WorkbenchToolbar ariaLabel="文件工具栏">
        <WorkbenchTabs
          ariaLabel="文件工作区"
          className="files-workbench__compact-tabs"
          active={compactView}
          onChange={(view) => useFilesStore.getState().setCompactView(view)}
          tabs={[
            { id: "browse", label: "浏览" },
            { id: "preview", label: "预览" },
          ]}
        />
        <span className="files-toolbar__path px-font-mono">
          {selectedPath ?? "请选择文件"}
        </span>
      </WorkbenchToolbar>
      <div className="files-workbench__panes" data-compact-view={compactView}>
        <WorkbenchPane
          paneId="files-browser"
          icon="files"
          label="资源管理器"
          ariaLabel="文件资源管理器"
          className="files-workbench__browser"
        >
          <WorkbenchTabs
            ariaLabel="资源管理器模式"
            active={sidebarMode}
            onChange={(mode) => useFilesStore.getState().setSidebarMode(mode)}
            tabs={[
              { id: "tree", label: "目录" },
              { id: "search", label: "搜索" },
            ]}
          />
          {sidebarMode === "tree" ? <DirectoryContent /> : <SearchContent />}
        </WorkbenchPane>
        <WorkbenchPane
          paneId="files-preview"
          icon="spec"
          label="文件预览"
          chip={selectedPath ? "已选择" : "空"}
          ariaLabel="文件预览"
          className="files-workbench__preview"
        >
          <PreviewContent path={selectedPath} />
        </WorkbenchPane>
      </div>
    </ToolWorkbench>
  );
}
