import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
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
  const currentTitle = expanded ? (expandedTitle ?? title) : title;
  const currentSubtitle = expanded ? (expandedSubtitle ?? subtitle) : subtitle;
  const collapsedLabel =
    currentSubtitle != null
      ? `${currentTitle} · ${currentSubtitle}`
      : currentTitle;
  const collapsedCopy = (
    <Text
      type="label"
      color="primary"
      maxLines={1}
      style={{ minWidth: 0, lineHeight: 1.25 }}
    >
      {collapsedLabel}
    </Text>
  );
  const expandedCopy = (
    <Stack gap={0.5} style={{ minWidth: 0 }}>
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

  const buttonLabel = collapsedLabel;

  if (!expanded) {
    return (
      <Button
        label={buttonLabel}
        variant="ghost"
        size="sm"
        type="button"
        className="nodrag node-bar__toggle"
        style={{
          width: "100%",
          height: "100%",
          lineHeight: 1.25,
          paddingBlock: 6,
          alignItems: "center",
        }}
        aria-expanded={false}
        onClick={onToggle}
        {...buttonProps}
      >
        <HStack align="center" justify="between" width="100%">
          <HStack align="center" gap={3}>
            <Stack style={{ color: accent }} aria-hidden>
              {icon}
            </Stack>
            {collapsedCopy}
          </HStack>
          <HStack align="center" gap={2}>
            {extras}
            <ChevronRight size={15} aria-hidden />
          </HStack>
        </HStack>
      </Button>
    );
  }

  return (
    <Toolbar
      label={currentTitle}
      className="nodrag"
      size="sm"
      variant="muted"
      startContent={
        <HStack align="center" gap={3}>
          <Stack style={{ color: accent }} aria-hidden>
            {expandedIcon ?? icon}
          </Stack>
          {expandedCopy}
        </HStack>
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
