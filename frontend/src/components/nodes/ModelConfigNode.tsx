import React, { useState } from "react";
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
import ModelSelect from "../ui/ModelSelect";

export default function ModelConfigNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "model-config" }>;
}) {
  const noModels = data.rpcStatus === "ready" && data.models.length === 0;
  const disabled = data.rpcStatus !== "ready" || data.models.length === 0;
  const [openSelectId, setOpenSelectId] = useState<string | null>(null);

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
          const modelSelectId = `${tier}-model`;
          const thinkingSelectId = `${tier}-thinking`;

          return (
            <section className="model-config-tier" key={tier}>
              <strong>{tierLabels[tier]}档</strong>
              <label>
                <span>模型</span>
                <ModelSelect
                  value={setting.model_id ?? ""}
                  disabled={disabled}
                  placeholder="选择模型"
                  open={openSelectId === modelSelectId}
                  onOpenChange={(isOpen) =>
                    setOpenSelectId(isOpen ? modelSelectId : null)
                  }
                  options={[
                    { value: "", label: "选择模型" },
                    ...data.models.map((model) => ({
                      value: model.id,
                      label: `${model.provider}/${model.name}`,
                    })),
                  ]}
                  onChange={(value) =>
                    data.onChange(tier, {
                      ...setting,
                      model_id: value || null,
                    })
                  }
                />
              </label>
              <label>
                <span>思考强度</span>
                <ModelSelect
                  value={setting.thinking_level}
                  disabled={disabled}
                  open={openSelectId === thinkingSelectId}
                  onOpenChange={(isOpen) =>
                    setOpenSelectId(isOpen ? thinkingSelectId : null)
                  }
                  options={thinkingLevels.map((level) => ({
                    value: level.value,
                    label: level.label,
                  }))}
                  onChange={(value) =>
                    data.onChange(tier, {
                      ...setting,
                      thinking_level: value as ThinkingLevel,
                    })
                  }
                />
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
