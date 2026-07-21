import { Handle, Position } from "@xyflow/react";
import type React from "react";
import { PixelIcon, type PixelIconName } from "../canvas/pixelIcons";

/**
 * 子画布节点共享外壳（四向 Handle：XYFlow 自定义节点无 Handle 不绘制边）。
 * P2 需求交付节点与 P3 各工作台节点共用同一像素语言。
 */
export function DNode({
  icon,
  label,
  chip,
  chipTone,
  children,
  actions,
  width,
  height,
  ariaLabel,
  className,
  handles = true,
}: {
  icon: PixelIconName;
  label: string;
  chip?: string | null;
  chipTone?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  width: number | string;
  handles?: boolean;
  height?: number;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <section
      className={`dnode px-cut px-shadowed-sm${className ? ` ${className}` : ""}`}
      style={{ width, height, boxSizing: "border-box" }}
      aria-label={ariaLabel}
    >
      {handles ? (
        <>
          <Handle
            type="target"
            position={Position.Left}
            id="in-l"
            isConnectable={false}
          />
          <Handle
            type="target"
            position={Position.Left}
            id="in-l-top"
            style={{ top: "32%" }}
            isConnectable={false}
          />
          <Handle
            type="target"
            position={Position.Left}
            id="in-l-bottom"
            style={{ top: "68%" }}
            isConnectable={false}
          />
          <Handle
            type="target"
            position={Position.Top}
            id="in-t"
            isConnectable={false}
          />
        </>
      ) : null}
      <header className="dnode__header">
        <span className="px-font-pixel dnode__label">
          <PixelIcon name={icon} size={12} />
          {label}
        </span>
        {chip ? (
          <span className="dnode__chip" data-tone={chipTone ?? "gray"}>
            {chip}
          </span>
        ) : null}
      </header>
      {children}
      {actions ? <footer className="dnode__actions">{actions}</footer> : null}
      {handles ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="out-r"
            isConnectable={false}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="out-r-top"
            style={{ top: "32%" }}
            isConnectable={false}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="out-r-bottom"
            style={{ top: "68%" }}
            isConnectable={false}
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="out-b"
            isConnectable={false}
          />
        </>
      ) : null}
    </section>
  );
}
