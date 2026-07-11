import { memo } from "react";
import { Item, List } from "@astryxdesign/core";
import { ChevronDown, ChevronRight, FileCode2, Folder } from "lucide-react";
import type { ProjectFileTreeEntry } from "../../types/api";

export interface FileTreeProps {
  entries: ProjectFileTreeEntry[];
  childrenByPath: Record<string, ProjectFileTreeEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  activePath: string | null;
  level?: number;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}

const indentForLevel = (level: number) =>
  level > 0
    ? { marginInlineStart: `calc(${level} * var(--spacing-4))` }
    : undefined;

export const FileTree = memo(function FileTree({
  entries,
  childrenByPath,
  expandedPaths,
  loadingPaths,
  activePath,
  level = 0,
  onToggleDirectory,
  onOpenFile,
}: FileTreeProps) {
  return (
    <List density="compact" listStyle="none">
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = expandedPaths.has(entry.path);
        const isLoading = loadingPaths.has(entry.path);
        const children = childrenByPath[entry.path];

        if (isDirectory) {
          return (
            <li key={entry.path}>
              <Item
                as="div"
                density="compact"
                label={entry.name}
                isSelected={activePath === entry.path}
                startContent={
                  <>
                    {isExpanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                    <Folder size={15} />
                  </>
                }
                style={indentForLevel(level)}
                onClick={() => onToggleDirectory(entry.path)}
              />
              {isExpanded && children && children.length > 0 ? (
                <FileTree
                  entries={children}
                  childrenByPath={childrenByPath}
                  expandedPaths={expandedPaths}
                  loadingPaths={loadingPaths}
                  activePath={activePath}
                  level={level + 1}
                  onToggleDirectory={onToggleDirectory}
                  onOpenFile={onOpenFile}
                />
              ) : null}
              {isExpanded && isLoading ? (
                <Item
                  as="div"
                  density="compact"
                  label="加载中…"
                  isDisabled
                  style={indentForLevel(level + 1)}
                />
              ) : null}
            </li>
          );
        }

        return (
          <Item
            key={entry.path}
            as="div"
            density="compact"
            label={entry.name}
            isSelected={activePath === entry.path}
            startContent={<FileCode2 size={15} />}
            style={indentForLevel(level)}
            onClick={() => onOpenFile(entry.path)}
          />
        );
      })}
    </List>
  );
});
