import React, { useEffect, useRef } from "react";
import { Handle, Position } from "@xyflow/react";
import { GitBranch, LoaderCircle, X } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { requirementStatusText } from "../../utils/format";
import { useRequirementPlanningThinking } from "../../contexts/RequirementTaskEventsContext";

export default function RequirementDagNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-dag" }>;
}) {
  const requirement = data.requirement;
  const plan = requirement.execution_plan;
  const thinking = useRequirementPlanningThinking();
  const thinkingScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (thinkingScrollRef.current) {
      thinkingScrollRef.current.scrollLeft =
        thinkingScrollRef.current.scrollWidth;
    }
  }, [thinking]);

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
        {!plan && requirement.status === "failed" ? (
          <p>执行 DAG 生成失败，可在右侧需求列表中重新生成。</p>
        ) : null}
        {!plan &&
        requirement.status !== "planning" &&
        requirement.status !== "failed" ? (
          <p>确认需求后会自动生成并执行 DAG。</p>
        ) : null}
        {data.actionError || requirement.error ? (
          <small className="dag-node__error">
            {data.actionError ?? requirement.error}
          </small>
        ) : null}
      </div>

      {requirement.status === "planning" ? (
        <div className="dag-node__thinking">
          <span className="dag-node__thinking-label">
            <LoaderCircle size={12} aria-hidden="true" />
            思考
          </span>
          <div ref={thinkingScrollRef} className="dag-node__thinking-scroll">
            <span className="dag-node__thinking-text">
              {thinking || "思考中…"}
            </span>
          </div>
        </div>
      ) : null}

      <Handle
        id="requirement-dag-entry"
        type="source"
        position={Position.Right}
        className="node-link-handle node-link-handle--requirement dag-node__entry-handle"
      />
    </>
  );
}
