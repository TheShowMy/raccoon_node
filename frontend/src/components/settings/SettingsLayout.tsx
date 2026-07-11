import { useState } from "react";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import {
  Layout,
  LayoutContent,
  LayoutPanel,
  VStack,
} from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import {
  ArrowLeft,
  ChevronRight,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import type { SettingsPage } from "../../types/api";

interface SettingsNavItem {
  id: SettingsPage;
  label: string;
  icon: typeof Settings;
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { id: "basic", label: "基础设置", icon: Settings },
  { id: "models", label: "模型设置", icon: SlidersHorizontal },
];

const PAGE_TITLES: Record<SettingsPage, string> = {
  basic: "基础设置",
  models: "模型设置",
};

interface SettingsLayoutProps {
  page: SettingsPage;
  onChangePage: (page: SettingsPage) => void;
  basicPanel: React.ReactNode;
  modelsPanel: React.ReactNode;
  banners?: React.ReactNode;
  sidebarTitle?: string;
  isContentScrollable?: boolean;
  contentClassName?: string;
  navItemProps?: Partial<
    Record<SettingsPage, Record<string, string | undefined>>
  >;
}

export default function SettingsLayout({
  page,
  onChangePage,
  basicPanel,
  modelsPanel,
  banners,
  sidebarTitle = "设置",
  isContentScrollable = true,
  contentClassName,
  navItemProps,
}: SettingsLayoutProps) {
  const isNarrow = useMediaQuery("(max-width: 768px)");
  const [mobileView, setMobileView] = useState<"nav" | "detail">("nav");

  const selectPage = (nextPage: SettingsPage) => {
    onChangePage(nextPage);
    setMobileView("detail");
  };

  const sidebar = (
    <VStack gap={4} padding={3}>
      <Heading level={2} style={{ marginInline: 12 }}>
        {sidebarTitle}
      </Heading>
      <List density="spacious">
        {SETTINGS_NAV_ITEMS.map((item) => {
          const ItemIcon = item.icon;
          const extraProps = navItemProps?.[item.id] ?? {};
          const dataAttributes = Object.fromEntries(
            Object.entries(extraProps).filter(([key]) =>
              key.startsWith("data-"),
            ),
          );
          const listItemProps = Object.fromEntries(
            Object.entries(extraProps).filter(
              ([key]) => !key.startsWith("data-"),
            ),
          );
          return (
            <ListItem
              key={item.id}
              label={item.label}
              startContent={
                <span {...dataAttributes}>
                  <Icon icon={ItemIcon} size="sm" />
                </span>
              }
              endContent={
                isNarrow ? (
                  <Icon icon={ChevronRight} size="sm" color="secondary" />
                ) : undefined
              }
              isSelected={!isNarrow && page === item.id}
              onClick={() => selectPage(item.id)}
              {...listItemProps}
            />
          );
        })}
      </List>
    </VStack>
  );

  // Narrow mobile view: show only the navigation menu.
  if (isNarrow && mobileView === "nav") {
    return (
      <Layout height="fill">
        <LayoutContent padding={2}>{sidebar}</LayoutContent>
      </Layout>
    );
  }

  return (
    <Layout
      height="fill"
      start={
        isNarrow ? undefined : (
          <LayoutPanel hasDivider padding={0}>
            {sidebar}
          </LayoutPanel>
        )
      }
      content={
        <LayoutContent
          padding={4}
          isScrollable={isContentScrollable}
          className={`nodrag nowheel ${contentClassName ?? ""}`.trim()}
        >
          <VStack gap={6} height="100%">
            {isNarrow && (
              <Toolbar
                label={`返回 ${sidebarTitle}`}
                gap={2}
                startContent={
                  <>
                    <Button
                      label={`返回 ${sidebarTitle}`}
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      icon={<Icon icon={ArrowLeft} size="sm" />}
                      onClick={() => setMobileView("nav")}
                    />
                    <Heading level={2}>{PAGE_TITLES[page]}</Heading>
                  </>
                }
              />
            )}
            {!isNarrow && <Heading level={2}>{PAGE_TITLES[page]}</Heading>}
            {banners}
            {page === "basic" ? basicPanel : modelsPanel}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
