import React from "react";
import { Moon, SunMedium } from "lucide-react";
import type { StartNodeData } from "../../types/api";

export default function StyleSettingsNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "style-settings" }>;
}) {
  return (
    <>
      <div className="node-header node-header--style">
        <span className="node-icon">
          {data.theme === "dark" ? <Moon size={20} /> : <SunMedium size={20} />}
        </span>
        <div>
          <strong>样式设置</strong>
          <span>{data.theme === "dark" ? "暗色主题" : "护眼亮色主题"}</span>
        </div>
      </div>
      <div className="theme-switcher" aria-label="样式主题">
        <button
          className={
            data.theme === "light" ? "theme-switcher__item--active" : ""
          }
          type="button"
          onClick={() => data.onThemeChange("light")}
        >
          <SunMedium size={14} />
          亮色
        </button>
        <button
          className={
            data.theme === "dark" ? "theme-switcher__item--active" : ""
          }
          type="button"
          onClick={() => data.onThemeChange("dark")}
        >
          <Moon size={14} />
          暗色
        </button>
      </div>
    </>
  );
}
