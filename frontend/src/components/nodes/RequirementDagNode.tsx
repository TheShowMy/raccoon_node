import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
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

  const header = (
    <Toolbar
      label="需求 DAG"
      className="nodrag"
      size="sm"
      variant="muted"
      startContent={
        <HStack align="center" gap={3}>
          <Stack style={{ color: "var(--color-accent)" }} aria-hidden>
            <GitBranch size={20} />
          </Stack>
          <Stack gap={0.5}>
            <Text type="label">需求 DAG</Text>
            <Text type="supporting" size="3xs">
              {requirementStatusText(requirement.status)}
            </Text>
          </Stack>
        </HStack>
      }
      endContent={
        <IconButton
          label="关闭 DAG"
          tooltip="关闭 DAG"
          icon={<X size={14} />}
          size="sm"
          variant="ghost"
          onClick={data.onClose}
        />
      }
    />
  );

  return (
    <>
      {header}

      <Stack padding={3} gap={2}>
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
          <Text type="supporting" color="accent" maxLines={2}>
            {data.actionError ?? requirement.error}
          </Text>
        ) : null}
      </Stack>

      {requirement.status === "planning" ? (
        <HStack
          align="center"
          gap={2}
          padding={2}
          paddingInline={3}
          style={{ minHeight: 0, borderTop: "1px solid var(--color-border)" }}
        >
          <HStack align="center" gap={1} style={{ flexShrink: 0 }}>
            <LoaderCircle size={12} aria-hidden="true" />
            <Text type="supporting" size="3xs">
              思考
            </Text>
          </HStack>
          <div
            ref={thinkingScrollRef}
            style={{ overflowX: "auto", minWidth: 0 }}
          >
            <Text type="supporting" size="3xs" maxLines={1}>
              {thinking || "思考中…"}
            </Text>
          </div>
        </HStack>
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
