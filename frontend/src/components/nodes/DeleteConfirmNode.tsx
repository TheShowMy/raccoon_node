import React from "react";
import { TriangleAlert } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { formatDate, shortenGitUrl } from "../../utils/format";

export default function DeleteConfirmNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "delete-confirm" }>;
}) {
  return (
    <>
      <div className="node-header node-header--danger">
        <span className="node-icon">
          <TriangleAlert size={20} />
        </span>
        <div>
          <strong>删除项目</strong>
          <span>确认该项目 item</span>
        </div>
      </div>
      <div className="delete-detail">
        <div>
          <span>项目名称</span>
          <strong title={data.project.name}>{data.project.name}</strong>
        </div>
        <div>
          <span>Git 链接</span>
          <strong title={data.project.git_url}>
            {shortenGitUrl(data.project.git_url)}
          </strong>
        </div>
        <div>
          <span>更新时间</span>
          <strong>{formatDate(data.project.updated_at)}</strong>
        </div>
      </div>
      <p className="delete-warning">
        将删除该项目记录、本地克隆目录和相关资源。
      </p>
      {data.error ? <p className="form-error">{data.error}</p> : null}
      <div className="delete-actions">
        <button
          className="delete-actions__cancel"
          type="button"
          disabled={data.deleting}
          onClick={data.onCancel}
        >
          取消
        </button>
        <button
          className="delete-actions__confirm"
          type="button"
          disabled={data.deleting}
          onClick={() => void data.onConfirm(data.project)}
        >
          {data.deleting ? "删除中" : "删除"}
        </button>
      </div>
    </>
  );
}
