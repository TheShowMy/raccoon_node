import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

interface NodeBarProps {
  icon: ReactNode;
  accent?: string;
  title: string;
  subtitle?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  extras?: ReactNode;
  actions?: ReactNode;
  expandedIcon?: ReactNode;
  expandedTitle?: string;
  expandedSubtitle?: ReactNode;
  buttonProps?: Record<`data-${string}`, string | undefined>;
}

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

  if (!expanded) {
    return (
      <Button
        label={title}
        variant="ghost"
        size="sm"
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
          <Text type="label" color="primary" maxLines={1}>
            {title}
          </Text>
          {subtitle != null ? (
            <Text type="supporting" size="4xs" maxLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </span>
        {extras}
        <ChevronRight size={15} className="node-bar__chevron" aria-hidden />
      </Button>
    );
  }

  return (
    <div className="node-bar node-bar--titlebar nodrag">
      <span className="node-bar__icon" style={iconStyle} aria-hidden>
        {expandedIcon ?? icon}
      </span>
      <span className="node-bar__copy">
        <Text type="label" color="primary" maxLines={1}>
          {expandedTitle ?? title}
        </Text>
        {(expandedSubtitle ?? subtitle) != null ? (
          <Text type="supporting" size="4xs" maxLines={1}>
            {expandedSubtitle ?? subtitle}
          </Text>
        ) : null}
      </span>
      {actions != null ? (
        <div className="node-bar__actions">{actions}</div>
      ) : null}
      <IconButton
        label="收起"
        tooltip="收起"
        icon={<ChevronDown size={14} />}
        size="sm"
        variant="ghost"
        onClick={onToggle}
      />
    </div>
  );
}
