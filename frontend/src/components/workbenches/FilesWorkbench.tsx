import { useEffect, useMemo, useState } from "react";
import {
  Banner,
  Button,
  CodeBlock,
  EmptyState,
  HStack,
  Item,
  Layout,
  LayoutContent,
  LayoutPanel,
  List,
  Markdown,
  Text,
  TextInput,
  VStack,
} from "@astryxdesign/core";
import { FileCode2, X } from "lucide-react";
import {
  getProjectFileContent,
  getProjectFiles,
  getProjectFileTree,
} from "../../api/client";
import type { ProjectFileTreeEntry } from "../../types/api";
import { getLanguageFromPath } from "../../utils/languageFromPath";
import { FileTree } from "./FileTree";

type OpenFile = { path: string; content: string; truncated: boolean };

export default function FilesWorkbench({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState("");
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [tree, setTree] = useState<Record<string, ProjectFileTreeEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadRoot = async () => {
      try {
        const entries = await getProjectFileTree(projectId, "");
        if (cancelled) return;
        setTree({ "": entries });
        setExpandedPaths(new Set([""]));
        setError(null);
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      }
    };
    loadRoot();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchPaths([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getProjectFiles(projectId, trimmed, controller.signal)
        .then((files) => {
          setSearchPaths(files.map((file) => file.path));
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

  const loadDirectory = async (path: string) => {
    if (tree[path]) return;
    setLoadingPaths((current) => new Set(current).add(path));
    try {
      const entries = await getProjectFileTree(projectId, path);
      setTree((current) => ({ ...current, [path]: entries }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  };

  const toggleDirectory = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!tree[path]) {
          void loadDirectory(path);
        }
      }
      return next;
    });
  };

  const openFile = async (path: string) => {
    setActivePath(path);
    setError(null);
    try {
      const file = await getProjectFileContent(projectId, path);
      setTabs((current) => {
        const existing = current.some((tab) => tab.path === path);
        return existing
          ? current.map((tab) =>
              tab.path === path
                ? { path, content: file.content, truncated: file.truncated }
                : tab,
            )
          : [
              ...current,
              { path, content: file.content, truncated: file.truncated },
            ];
      });
    } catch (reason) {
      setError(String(reason));
    }
  };

  const closeTab = (path: string) => {
    const nextTabs = tabs.filter((tab) => tab.path !== path);
    setTabs(nextTabs);
    setActivePath((current) =>
      current === path
        ? (nextTabs[nextTabs.length - 1]?.path ?? null)
        : current,
    );
  };

  const isSearching = query.trim().length > 0;
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  const isMarkdown = activeTab?.path.toLowerCase().endsWith(".md") ?? false;
  const language = activeTab
    ? getLanguageFromPath(activeTab.path)
    : "plaintext";

  const fileList = useMemo(() => {
    if (isSearching) {
      return searchPaths.length ? (
        <List density="compact" listStyle="none">
          {searchPaths.map((path) => (
            <Item
              key={path}
              as="div"
              density="compact"
              label={path}
              startContent={<FileCode2 size={15} />}
              onClick={() => void openFile(path)}
            />
          ))}
        </List>
      ) : (
        <EmptyState isCompact title="没有匹配文件" />
      );
    }
    if (tree[""]) {
      return (
        <FileTree
          entries={tree[""]}
          childrenByPath={tree}
          expandedPaths={expandedPaths}
          loadingPaths={loadingPaths}
          activePath={activePath}
          onToggleDirectory={toggleDirectory}
          onOpenFile={(path) => void openFile(path)}
        />
      );
    }
    return <EmptyState isCompact title="仓库中没有可预览文件" />;
  }, [activePath, expandedPaths, isSearching, loadingPaths, searchPaths, tree]);

  const fileListPanel = (
    <LayoutPanel
      padding={2}
      width={280}
      hasDivider
      isScrollable
      className="nodrag nowheel"
    >
      <VStack gap={2}>
        <TextInput
          label="搜索文件"
          isLabelHidden
          placeholder="搜索仓库文件"
          startIcon="search"
          value={query}
          onChange={setQuery}
        />
        {fileList}
      </VStack>
    </LayoutPanel>
  );

  return (
    <Layout height="fill" padding={0} start={fileListPanel}>
      <LayoutContent padding={0} isScrollable className="nodrag nowheel">
        {error ? <Text color="accent">{error}</Text> : null}
        {tabs.length > 0 ? (
          <HStack gap={1} padding={2} wrap="wrap">
            {tabs.map((tab) => {
              const active = tab.path === activePath;
              return (
                <Button
                  key={tab.path}
                  label={tab.path}
                  size="sm"
                  variant={active ? "secondary" : "ghost"}
                  endContent={
                    <X
                      size={14}
                      aria-label={`关闭 ${tab.path}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.path);
                      }}
                    />
                  }
                  onClick={() => setActivePath(tab.path)}
                />
              );
            })}
          </HStack>
        ) : null}
        {activeTab ? (
          <VStack gap={3} padding={4}>
            <HStack align="center" gap={2}>
              <FileCode2 size={18} />
              <Text weight="semibold">{activeTab.path}</Text>
            </HStack>
            {activeTab.truncated ? (
              <Banner
                status="warning"
                title="文件过大"
                description="仅显示前 1MB，完整文件请使用外部编辑器查看。"
              />
            ) : null}
            {isMarkdown ? (
              <Markdown>{activeTab.content}</Markdown>
            ) : (
              <CodeBlock
                code={activeTab.content}
                language={language}
                title={activeTab.path}
                width="100%"
                hasLineNumbers
              />
            )}
          </VStack>
        ) : (
          <VStack height="100%" justify="center" align="center" padding={4}>
            <VStack
              align="center"
              gap={0}
              style={{ position: "relative", marginTop: "-5%" }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  bottom: "100%",
                  marginBottom: "var(--spacing-4)",
                }}
              >
                <FileCode2 size={40} />
              </span>
              <EmptyState
                title="选择文件进行预览"
                description="点击左侧文件树中的文件，即可在此处查看代码或文档。"
              />
            </VStack>
          </VStack>
        )}
      </LayoutContent>
    </Layout>
  );
}
