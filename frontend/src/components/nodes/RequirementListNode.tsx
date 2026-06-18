import React from "react";
import { CheckCircle2, Clock } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { formatDate, requirementStatusText } from "../../utils/format";

export default function RequirementListNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-list" }>;
}) {
  const Icon = data.tone === "done" ? CheckCircle2 : Clock;
  return (
    <>
      <div
        className={`node-header ${
          data.tone === "done" ? "node-header--projects" : "node-header--create"
        }`}
      >
        <span className="node-icon">
          <Icon size={20} />
        </span>
        <div>
          <strong>{data.title}</strong>
          <span>{data.description}</span>
        </div>
      </div>
      {data.requirements.length === 0 ? (
        <div className="empty-state">{data.emptyText}</div>
      ) : (
        <div className="requirement-list">
          {data.requirements.map((requirement) => (
            <div className="requirement-list__item" key={requirement.id}>
              <strong>{requirement.title}</strong>
              <span>{requirementStatusText(requirement.status)}</span>
              <small>更新于 {formatDate(requirement.updated_at)}</small>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
