import React from "react";
import { Handle, Position } from "@xyflow/react";
import { GitBranch, Loader2, Play, X } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { requirementStatusText } from "../../utils/format";

export default function RequirementDagNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-dag" }>;
}) {
  const requirement = data.requirement;
  const plan = requirement.execution_plan;
  const canStart = requirement.status === "plan_ready" && Boolean(plan);

  return (
    <>
      <div className="node-header node-header--model">
        <span className="node-icon">
          <GitBranch size={20} />
        </span>
        <div>
          <strong>需求 DAG</strong>
          <span>{requirementStatusText(requirement.status)}</span>
        </div>
        <button
          className="dag-node__close nowheel nodrag"
          type="button"
          onClick={data.onClose}
          aria-label="关闭 DAG"
        >
          <X size={14} />
        </button>
      </div>

      <div className="dag-node__body">
        <strong>{requirement.title}</strong>
        {plan ? <p>{plan.summary}</p> : null}
        {!plan && requirement.status === "planning" ? (
          <p>Coordinator 正在生成执行 DAG...</p>
        ) : null}
        {!plan && requirement.status !== "planning" ? (
          <p>请在右侧需求列表卡片中点击“生成 DAG”。</p>
        ) : null}
        {requirement.error ? (
          <small className="dag-node__error">{requirement.error}</small>
        ) : null}
      </div>

      <div className="dag-node__actions nowheel nodrag">
        {canStart ? (
          <button
            type="button"
            disabled={data.busy}
            onClick={() => void data.onStartExecution(requirement)}
          >
            {data.busy ? (
              <Loader2 size={14} className="spin-icon" />
            ) : (
              <Play size={14} />
            )}
            {data.busy ? "启动中" : "开始执行"}
          </button>
        ) : null}
      </div>
      <Handle
        id="requirement-dag-entry"
        type="source"
        position={Position.Right}
        className="node-link-handle node-link-handle--requirement dag-node__entry-handle"
      />
    </>
  );
}
