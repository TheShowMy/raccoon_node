import React from "react";
import { ArrowLeft } from "lucide-react";
import type { StartNodeData } from "../../types/api";

export default function ProjectBackNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "project-back" }>;
}) {
  return (
    <>
      <div className="node-header node-header--projects">
        <span className="node-icon">
          <ArrowLeft size={20} />
        </span>
        <div>
          <strong>返回 Start</strong>
          <span>{data.project.name}</span>
        </div>
      </div>
    </>
  );
}
