import { Card } from "@astryxdesign/core/Card";
import type { Node, NodeProps } from "@xyflow/react";
import RequirementChatNode from "../components/nodes/RequirementChatNode";
import type { StartNodeData } from "../types/api";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;

export default function ChatCanvasNode({ data }: NodeProps<Node<ChatData>>) {
  return (
    <Card
      width="100%"
      height="100%"
      padding={0}
      className="node-card node-card--requirement-chat nowheel"
    >
      <RequirementChatNode data={data} />
    </Card>
  );
}
