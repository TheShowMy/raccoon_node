import { IconButton } from "@astryxdesign/core/IconButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useRef } from "react";
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
        <Stack gap={0.5}>
          <Text type="label">需求 DAG</Text>
          <Text type="supporting" size="3xs">
            {requirementStatusText(requirement.status)}
          </Text>
        </Stack>
        <span className="dag-node__close nowheel nodrag">
          <IconButton
            label="关闭 DAG"
            tooltip="关闭 DAG"
            icon={<X size={14} />}
            size="sm"
            variant="ghost"
            onClick={data.onClose}
          />
        </span>
      </div>

      <Stack className="dag-node__body" gap={2}>
        <Text type="label" maxLines={2} wordBreak="break-word">
          {requirement.title}
        </Text>
        {!plan && requirement.status === "failed" ? (
          <Text type="supporting" maxLines={3}>
            执行 DAG 生成失败，可在右侧需求列表中重新生成。
          </Text>
        ) : null}
        {!plan &&
        requirement.status !== "planning" &&
        requirement.status !== "failed" ? (
          <Text type="supporting" maxLines={3}>
            确认需求后会自动生成并执行 DAG。
          </Text>
        ) : null}
        {data.actionError || requirement.error ? (
          <Text
            className="dag-node__error"
            type="supporting"
            color="accent"
            maxLines={2}
          >
            {data.actionError ?? requirement.error}
          </Text>
        ) : null}
      </Stack>

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
