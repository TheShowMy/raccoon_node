import { List, ListItem } from "@astryxdesign/core/List";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { CheckCircle2, Github, TriangleAlert } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { githubUrlFromGitUrl, shortenGitUrl } from "../../utils/format";
import NodeBar from "../ui/NodeBar";

type GithubData = Extract<StartNodeData, { kind: "project-github" }>;

export default function ProjectGithubNode({ data }: { data: GithubData }) {
  const githubUrl = githubUrlFromGitUrl(data.project.git_url);
  const readiness = data.publicationReadiness;
  const local = readiness.mode === "local";
  const StatusIcon = readiness.ready ? CheckCircle2 : TriangleAlert;

  const collapsedIcon = local ? <Github size={16} /> : <StatusIcon size={16} />;
  const collapsedAccent = local
    ? "var(--accent-projects)"
    : readiness.ready
      ? "var(--color-success)"
      : "var(--color-warning)";
  const collapsedSubtitle = local
    ? "无需 PR"
    : readiness.ready
      ? "前置检查通过"
      : `${readiness.issues.length} 项待处理`;
  const statusVariant = local
    ? "neutral"
    : readiness.ready
      ? "success"
      : "warning";

  if (!data.expanded) {
    return (
      <NodeBar
        icon={collapsedIcon}
        accent={collapsedAccent}
        title={local ? "本地发布" : "PR 发布"}
        subtitle={collapsedSubtitle}
        expanded={false}
        onToggle={data.onToggleExpanded}
      />
    );
  }

  return (
    <section className="github-node">
      <NodeBar
        icon={collapsedIcon}
        expandedIcon={<StatusIcon size={16} />}
        accent={collapsedAccent}
        title={local ? "本地发布" : "PR 发布"}
        expandedTitle={readiness.summary}
        expanded={true}
        onToggle={data.onToggleExpanded}
      />

      <Stack className="github-node__body nodrag nowheel" gap={3} padding={4}>
        <Stack direction="horizontal" gap={1.5} align="center">
          <StatusDot
            variant={statusVariant}
            label={readiness.summary}
            isPulsing={!local && !readiness.ready}
          />
          <Text type="label" maxLines={1} wordBreak="break-all">
            {readiness.summary}
          </Text>
        </Stack>

        <Stack className="github-node__meta" gap={0.5}>
          <Text type="supporting">仓库</Text>
          <Text type="label" maxLines={1} wordBreak="break-all">
            {data.project.git_url
              ? shortenGitUrl(data.project.git_url)
              : "当前仓库未配置 origin"}
          </Text>
        </Stack>

        {readiness.issues.length > 0 ? (
          <List
            density="compact"
            listStyle="disc"
            header={<Text type="label">需要处理</Text>}
          >
            {readiness.issues.map((issue) => (
              <ListItem key={issue} label={issue} />
            ))}
          </List>
        ) : null}

        {readiness.issues.length > 0 ? (
          <Text type="supporting" color="accent">
            处理完成后请重启应用，启动时会重新检查。
          </Text>
        ) : null}

        {readiness.notes.length > 0 ? (
          <List
            density="compact"
            listStyle="disc"
            header={<Text type="label">说明</Text>}
          >
            {readiness.notes.map((note) => (
              <ListItem key={note} label={note} />
            ))}
          </List>
        ) : null}

        {githubUrl ? (
          <a
            className="github-node__link"
            href={githubUrl}
            target="_blank"
            rel="noreferrer"
          >
            打开 GitHub 仓库
          </a>
        ) : null}
      </Stack>
    </section>
  );
}
