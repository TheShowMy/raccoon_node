import React from "react";
import { Github } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { githubUrlFromGitUrl, shortenGitUrl } from "../../utils/format";

export default function ProjectGithubNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "project-github" }>;
}) {
  const githubUrl = githubUrlFromGitUrl(data.project.git_url);

  return (
    <div className="node-header node-header--projects">
      <span className="node-icon">
        <Github size={20} />
      </span>
      <div>
        <strong>GitHub 仓库</strong>
        <span title={data.project.git_url}>
          {githubUrl ? shortenGitUrl(data.project.git_url) : "非 GitHub 仓库"}
        </span>
      </div>
    </div>
  );
}
