import { useEffect, useMemo, useState } from "react";
import {
  Button,
  CodeBlock,
  EmptyState,
  HStack,
  Layout,
  LayoutContent,
  LayoutPanel,
  Markdown,
  Tab,
  TabList,
  Text,
  TextInput,
  TreeList,
  VStack,
} from "@astryxdesign/core";
import type { TreeListItemData } from "@astryxdesign/core/TreeList";
import { FileCode2, Folder } from "lucide-react";
import { getProjectFileContent, getProjectFiles } from "../../api/client";

type OpenFile = { path: string; content: string };

export function buildFileTree(
  paths: string[],
  activePath: string | null,
  onOpen: (path: string) => void,
): TreeListItemData[] {
  type Branch = { files: Set<string>; folders: Map<string, Branch> };
  const root: Branch = { files: new Set(), folders: new Map() };
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let branch = root;
    for (const folder of parts.slice(0, -1)) {
      let child = branch.folders.get(folder);
      if (!child) {
        child = { files: new Set(), folders: new Map() };
        branch.folders.set(folder, child);
      }
      branch = child;
    }
    const file = parts.at(-1);
    if (file) branch.files.add(file);
  }

  const renderBranch = (branch: Branch, prefix: string): TreeListItemData[] => [
    ...[...branch.folders.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, child]) => {
        const path = prefix ? `${prefix}/${name}` : name;
        return {
          id: `folder:${path}`,
          label: name,
          startContent: <Folder size={15} />,
          isExpanded: prefix === "",
          children: renderBranch(child, path),
        };
      }),
    ...[...branch.files]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => {
        const path = prefix ? `${prefix}/${name}` : name;
        return {
          id: `file:${path}`,
          label: name,
          description: prefix || undefined,
          startContent: <FileCode2 size={15} />,
          isSelected: path === activePath,
          onClick: () => onOpen(path),
        };
      }),
  ];

  return renderBranch(root, "");
}

export default function FilesWorkbench({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getProjectFiles(projectId, query, controller.signal)
        .then((files) => {
          setPaths(files.map((file) => file.path));
          setError(null);
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(String(reason));
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, query]);

  const openFile = async (path: string) => {
    setActivePath(path);
    setError(null);
    try {
      const file = await getProjectFileContent(projectId, path);
      setTabs((current) => {
        const existing = current.some((tab) => tab.path === path);
        return existing
          ? current.map((tab) =>
              tab.path === path ? { path, content: file.content } : tab,
            )
          : [...current, { path, content: file.content }];
      });
    } catch (reason) {
      setError(String(reason));
    }
  };

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  const isMarkdown = activeTab?.path.toLowerCase().endsWith(".md") ?? false;
  const treeItems = useMemo(
    () => buildFileTree(paths, activePath, (path) => void openFile(path)),
    [activePath, paths],
  );

  return (
    <Layout height="fill" padding={0}>
      <LayoutPanel padding={2} width={320} hasDivider isScrollable>
        <VStack gap={2}>
          <TextInput
            label="搜索文件"
            isLabelHidden
            placeholder="搜索仓库文件"
            startIcon="search"
            value={query}
            onChange={setQuery}
          />
          {treeItems.length ? (
            <TreeList items={treeItems} density="compact" />
          ) : (
            <EmptyState
              isCompact
              title={query ? "没有匹配文件" : "仓库中没有可预览文件"}
            />
          )}
        </VStack>
      </LayoutPanel>
      <LayoutContent padding={0} isScrollable>
        {error ? <Text color="accent">{error}</Text> : null}
        {tabs.length ? (
          <TabList value={activePath ?? ""} onChange={setActivePath} hasDivider>
            {tabs.map((tab) => (
              <Tab key={tab.path} value={tab.path} label={tab.path} />
            ))}
          </TabList>
        ) : null}
        {activeTab ? (
          <VStack gap={3} padding={4}>
            <HStack align="center" gap={2}>
              <FileCode2 size={18} />
              <Text weight="semibold">{activeTab.path}</Text>
            </HStack>
            {isMarkdown ? (
              <Markdown>{activeTab.content}</Markdown>
            ) : (
              <CodeBlock
                code={activeTab.content}
                language="plaintext"
                title={activeTab.path}
                width="100%"
                hasLineNumbers
              />
            )}
          </VStack>
        ) : (
          <EmptyState isCompact title="选择文件进行预览" />
        )}
      </LayoutContent>
    </Layout>
  );
}
