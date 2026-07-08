import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
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
  const currentTitle = expanded ? (expandedTitle ?? title) : title;
  const currentSubtitle = expanded ? (expandedSubtitle ?? subtitle) : subtitle;
  const copy = (
    <Stack className="node-bar__copy" gap={0.5}>
      <Text type="label" color="primary" maxLines={1}>
        {currentTitle}
      </Text>
      {currentSubtitle != null ? (
        <Text type="supporting" size="4xs" maxLines={1}>
          {currentSubtitle}
        </Text>
      ) : null}
    </Stack>
  );

  if (!expanded) {
    return (
      <Button
        label={title}
        variant="ghost"
        size="sm"
        type="button"
        className="node-bar node-bar--collapsed nodrag"
        aria-expanded={false}
        onClick={onToggle}
        {...buttonProps}
      >
        <Stack direction="horizontal" gap={3} align="center" width="100%">
          <span className="node-bar__icon" style={iconStyle} aria-hidden>
            {icon}
          </span>
          {copy}
        </Stack>
        {extras}
        <ChevronRight size={15} className="node-bar__chevron" aria-hidden />
      </Button>
    );
  }

  return (
    <Toolbar
      label={currentTitle}
      className="node-bar node-bar--titlebar nodrag"
      size="sm"
      variant="muted"
      startContent={
        <Stack direction="horizontal" gap={3} align="center" width="100%">
          <span className="node-bar__icon" style={iconStyle} aria-hidden>
            {expandedIcon ?? icon}
          </span>
          {copy}
        </Stack>
      }
      endContent={
        <>
          {actions}
          <IconButton
            label="收起"
            tooltip="收起"
            icon={<ChevronDown size={14} />}
            variant="ghost"
            onClick={onToggle}
          />
        </>
      }
    />
  );
}
