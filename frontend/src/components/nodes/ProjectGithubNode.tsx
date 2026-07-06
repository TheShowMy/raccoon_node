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

      <div className="github-node__body nodrag nowheel">
        <div className="github-node__meta">
          <span>仓库</span>
          <span title={data.project.git_url}>
            {data.project.git_url
              ? shortenGitUrl(data.project.git_url)
              : "当前仓库未配置 origin"}
          </span>
        </div>

        {readiness.issues.length > 0 ? (
          <>
            <h3>需要处理</h3>
            <ul className="github-node__issues">
              {readiness.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
            <p className="github-node__restart">
              处理完成后请重启应用，启动时会重新检查。
            </p>
          </>
        ) : null}

        {readiness.notes.length > 0 ? (
          <>
            <h3>说明</h3>
            <ul className="github-node__notes">
              {readiness.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </>
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
      </div>
    </section>
  );
}
