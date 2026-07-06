import { ChevronDown, ChevronRight } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface NodeBarProps {
  /** Lucide icon element — recommended size 16 */
  icon: ReactNode;
  /** CSS color value for the icon, e.g. 'var(--accent-model)' */
  accent?: string;
  /** Primary label (shown in both states) */
  title: string;
  /** Secondary label below the title */
  subtitle?: ReactNode;
  /** Whether the node is expanded */
  expanded: boolean;
  /** Toggle expand/collapse */
  onToggle: () => void;
  /**
   * Extra nodes between subtitle and the trailing chevron — collapsed only.
   * Use for error badges, spinners, etc.
   */
  extras?: ReactNode;
  /**
   * Action buttons rendered left of the collapse chevron — expanded titlebar only.
   * Each button should use className="node-bar__btn".
   */
  actions?: ReactNode;
  /** Override icon for the expanded titlebar if it differs from the collapsed icon */
  expandedIcon?: ReactNode;
  /** Override title for the expanded titlebar if it differs */
  expandedTitle?: string;
  /** Override subtitle for the expanded titlebar if it differs */
  expandedSubtitle?: ReactNode;
  /** Extra HTML attributes forwarded to the collapsed `<button>` */
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}

/**
 * NodeBar — unified collapsible header for small canvas nodes.
 *
 * Renders as a full-width `<button>` when collapsed and as a
 * static `<div>` titlebar when expanded. Both states share identical
 * height, padding, gap, icon size and typography.
 */
export default function NodeBar({
  icon,
  accent,
  title,
  subtitle,
  expanded,
  onToggle,
  extras,
  actions,
  expandedIcon,
  expandedTitle,
  expandedSubtitle,
  buttonProps,
}: NodeBarProps) {
  const iconStyle = accent ? { color: accent } : undefined;

  /* ── Collapsed: full-width toggle button ── */
  if (!expanded) {
    return (
      <button
        type="button"
        className="node-bar nodrag"
        aria-expanded={false}
        onClick={onToggle}
        {...buttonProps}
      >
        <span className="node-bar__icon" style={iconStyle} aria-hidden>
          {icon}
        </span>
        <span className="node-bar__copy">
          <strong>{title}</strong>
          {subtitle != null ? <small>{subtitle}</small> : null}
        </span>
        {extras}
        <ChevronRight size={15} className="node-bar__chevron" aria-hidden />
      </button>
    );
  }

  /* ── Expanded: static titlebar with actions + collapse button ── */
  return (
    <div className="node-bar node-bar--titlebar nodrag">
      <span className="node-bar__icon" style={iconStyle} aria-hidden>
        {expandedIcon ?? icon}
      </span>
      <span className="node-bar__copy">
        <strong>{expandedTitle ?? title}</strong>
        {(expandedSubtitle ?? subtitle) != null ? (
          <small>{expandedSubtitle ?? subtitle}</small>
        ) : null}
      </span>
      {actions != null ? (
        <div className="node-bar__actions">{actions}</div>
      ) : null}
      <button
        type="button"
        className="node-bar__btn"
        aria-label="收起"
        onClick={onToggle}
      >
        <ChevronDown size={14} />
      </button>
    </div>
  );
}
