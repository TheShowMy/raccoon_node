import React from "react";
import { ListTree } from "lucide-react";

export default function ProjectListNode({
  projectCount,
}: {
  projectCount: number;
}) {
  return (
    <>
      <div className="node-header node-header--projects">
        <span className="node-icon">
          <ListTree size={20} />
        </span>
        <div>
          <strong>项目列表</strong>
          <span>{projectCount} 个项目</span>
        </div>
      </div>
      {projectCount === 0 ? (
        <div className="empty-state">暂无项目</div>
      ) : (
        <div className="project-summary">
          <strong>{projectCount}</strong>
        </div>
      )}
    </>
  );
}
