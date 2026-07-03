import { CheckCircle2, Github, TriangleAlert, X } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { githubUrlFromGitUrl, shortenGitUrl } from "../../utils/format";

type GithubData = Extract<StartNodeData, { kind: "project-github" }>;

export default function ProjectGithubNode({ data }: { data: GithubData }) {
  const githubUrl = githubUrlFromGitUrl(data.project.git_url);
  const readiness = data.publicationReadiness;
  const local = readiness.mode === "local";
  const StatusIcon = readiness.ready ? CheckCircle2 : TriangleAlert;

  if (!data.expanded) {
    return (
      <button
        type="button"
        className="github-node__collapsed nodrag"
        aria-expanded="false"
        onClick={data.onToggleExpanded}
      >
        <span>{local ? <Github size={17} /> : <StatusIcon size={17} />}</span>
        <span>
          <strong>{local ? "本地发布" : "PR 发布"}</strong>
          <small className={readiness.ready ? "is-ready" : "is-blocked"}>
            {local
              ? "无需 PR"
              : readiness.ready
                ? "前置检查通过"
                : `${readiness.issues.length} 项待处理`}
          </small>
        </span>
      </button>
    );
  }

  return (
    <section className="github-node">
      <header className="github-node__titlebar nodrag">
        <StatusIcon size={17} />
        <strong>{readiness.summary}</strong>
        <button
          type="button"
          aria-label="收起发布检查"
          onClick={data.onToggleExpanded}
        >
          <X size={15} />
        </button>
      </header>

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
