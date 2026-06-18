import React from "react";
import { Trash2 } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { formatDate, shortenGitUrl } from "../../utils/format";

export default function ProjectItemNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "project-item" }>;
}) {
  const isPendingDelete = data.pendingDeleteProjectId === data.project.id;

  return (
    <>
      <div className="project-item-node__header">
        <button
          className="project-item-node__main"
          type="button"
          onClick={() => data.onOpenProject(data.project)}
        >
          <span>{data.project.name}</span>
          <small title={data.project.git_url}>
            {shortenGitUrl(data.project.git_url)}
          </small>
          <small>更新于 {formatDate(data.project.updated_at)}</small>
        </button>
        <button
          className="project-item-node__delete"
          type="button"
          disabled={data.deletingId === data.project.id || isPendingDelete}
          aria-label={`删除项目 ${data.project.name}`}
          onClick={() => data.onDeleteRequest(data.project)}
          title="删除项目"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </>
  );
}
