import type React from "react";
import { PixelIcon, type PixelIconName } from "../../canvas/pixelIcons";

export function ToolWorkbench({
  className,
  children,
  ariaLabel,
}: {
  className?: string;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <div
      className={`tool-workbench${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

export function WorkbenchToolbar({
  children,
  ariaLabel,
}: {
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <header className="tool-workbench__toolbar px-cut" aria-label={ariaLabel}>
      {children}
    </header>
  );
}

export function WorkbenchPane({
  paneId,
  icon,
  label,
  chip,
  chipTone,
  children,
  actions,
  ariaLabel,
  className,
  compactActive,
}: {
  paneId: string;
  icon?: PixelIconName;
  label?: string;
  chip?: string | null;
  chipTone?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  ariaLabel: string;
  className?: string;
  compactActive?: boolean;
}) {
  return (
    <section
      className={`workbench-pane px-cut${className ? ` ${className}` : ""}`}
      data-pane-id={paneId}
      data-compact-active={compactActive || undefined}
      aria-label={ariaLabel}
    >
      {label ? (
        <header className="workbench-pane__header">
          <span className="px-font-pixel workbench-pane__label">
            {icon ? <PixelIcon name={icon} size={12} /> : null}
            {label}
          </span>
          <span className="workbench-pane__header-end">
            {chip ? (
              <span
                className="workbench-pane__chip"
                data-tone={chipTone ?? "gray"}
              >
                {chip}
              </span>
            ) : null}
            {actions}
          </span>
        </header>
      ) : null}
      <div
        className="workbench-pane__content nodrag nowheel"
        data-scroll-key={paneId}
      >
        {children}
      </div>
    </section>
  );
}

export type WorkbenchTab<T extends string> = {
  id: T;
  label: string;
  badge?: string | number | null;
};

export function WorkbenchTabs<T extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  className,
}: {
  tabs: WorkbenchTab<T>[];
  active: T;
  onChange: (tab: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      className={`workbench-tabs${className ? ` ${className}` : ""}`}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          return;
        }
        event.preventDefault();
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]',
          ),
        );
        const current = items.findIndex((el) => el === document.activeElement);
        if (current === -1) {
          return;
        }
        let next = current;
        if (event.key === "ArrowRight") {
          next = (current + 1) % items.length;
        } else if (event.key === "ArrowLeft") {
          next = (current - 1 + items.length) % items.length;
        } else if (event.key === "Home") {
          next = 0;
        } else if (event.key === "End") {
          next = items.length - 1;
        }
        items[next]?.focus();
        const target = tabs[next];
        if (target) {
          onChange(target.id);
        }
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          tabIndex={active === tab.id ? 0 : -1}
          className="workbench-tabs__tab"
          data-active={active === tab.id || undefined}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge !== null ? (
            <span className="workbench-tabs__badge">{tab.badge}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
