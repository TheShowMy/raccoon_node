import React from "react";
import { SlidersHorizontal } from "lucide-react";
import type { StartNodeData } from "../../types/api";

export default function SummaryCard({
  data,
}: {
  data: Extract<StartNodeData, { kind: "summary" }>;
}) {
  return (
    <>
      <div className={`node-header node-header--${data.icon}`}>
        <span className="node-icon">
          <SlidersHorizontal size={20} />
        </span>
        <div>
          <strong>{data.title}</strong>
          <span>{data.description}</span>
        </div>
      </div>
    </>
  );
}
