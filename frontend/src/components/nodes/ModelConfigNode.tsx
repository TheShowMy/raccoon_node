import React from "react";
import { SlidersHorizontal } from "lucide-react";
import type {
  StartNodeData,
  ModelTierKey,
  ThinkingLevel,
} from "../../types/api";
import {
  modelStatusText,
  tierLabels,
  thinkingLevels,
} from "../../utils/format";

export default function ModelConfigNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "model-config" }>;
}) {
  const noModels = data.rpcStatus === "ready" && data.models.length === 0;
  const disabled = data.rpcStatus !== "ready" || data.models.length === 0;

  return (
    <>
      <div className="node-header node-header--model">
        <span className="node-icon">
          <SlidersHorizontal size={20} />
        </span>
        <div>
          <strong>模型配置</strong>
          <span>{modelStatusText(data.rpcStatus)}</span>
        </div>
      </div>
      {noModels ? (
        <p className="model-notice">
          Pi Agent 中还没有已配置模型，请先在 Pi Agent 中完成模型配置。
        </p>
      ) : null}
      {data.error ? <p className="form-error">{data.error}</p> : null}
      <div className="model-config-grid">
        {(["low", "medium", "high"] as ModelTierKey[]).map((tier) => {
          const setting = data.settings[tier];

          return (
            <section className="model-config-tier" key={tier}>
              <strong>{tierLabels[tier]}档</strong>
              <label>
                <span>模型</span>
                <select
                  value={setting.model_id ?? ""}
                  disabled={disabled}
                  onChange={(event) =>
                    data.onChange(tier, {
                      ...setting,
                      model_id: event.target.value || null,
                    })
                  }
                >
                  <option value="">选择模型</option>
                  {data.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.provider}/{model.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>思考强度</span>
                <select
                  value={setting.thinking_level}
                  disabled={disabled}
                  onChange={(event) =>
                    data.onChange(tier, {
                      ...setting,
                      thinking_level: event.target.value as ThinkingLevel,
                    })
                  }
                >
                  {thinkingLevels.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          );
        })}
      </div>
      <div className="model-actions">
        <button
          className="model-actions__close"
          type="button"
          disabled={data.saving}
          onClick={data.onClose}
        >
          关闭
        </button>
        <button
          className="model-actions__save"
          type="button"
          disabled={
            data.saving ||
            data.rpcStatus !== "ready" ||
            data.models.length === 0
          }
          onClick={() => void data.onSave()}
        >
          {data.saving ? "保存中" : "保存"}
        </button>
      </div>
    </>
  );
}
