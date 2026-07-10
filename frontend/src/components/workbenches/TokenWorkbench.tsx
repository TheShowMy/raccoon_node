import TokenUsageNode from "../nodes/TokenUsageNode";
import type { StartNodeData } from "../../types/api";

type TokenData = Extract<StartNodeData, { kind: "token-usage" }>;

export default function TokenWorkbench({ data }: { data: TokenData }) {
  return <TokenUsageNode data={data} />;
}
