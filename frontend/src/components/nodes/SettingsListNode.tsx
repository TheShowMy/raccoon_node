import { Moon, Settings, SlidersHorizontal, Sun } from "lucide-react";
import type { StartNodeData } from "../../types/api";

export default function SettingsListNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "settings-list" }>;
}) {
  return (
    <>
      <div className="node-header node-header--model">
        <span className="node-icon">
          <Settings size={20} />
        </span>
        <div>
          <strong>设置</strong>
          <span>选择要配置的项目</span>
        </div>
      </div>
      <div className="settings-list">
        <button type="button" onClick={data.onOpenBasic}>
          <span className="settings-list__icons">
            <Sun size={16} />
            <Moon size={16} />
          </span>
          <strong>基础设置</strong>
          <small>主题与服务端口</small>
        </button>
        <button type="button" onClick={data.onOpenModels}>
          <SlidersHorizontal size={18} />
          <strong>模型设置</strong>
          <small>配置任务使用的模型档位</small>
        </button>
      </div>
      <button className="settings-close" type="button" onClick={data.onClose}>
        关闭
      </button>
    </>
  );
}
