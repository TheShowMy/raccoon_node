import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Github, TriangleAlert, X } from "lucide-react";
import type { StartNodeData } from "../../types/api";
import { githubUrlFromGitUrl, shortenGitUrl } from "../../utils/format";

export default function ProjectGithubNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "project-github" }>;
}) {
  const githubUrl = githubUrlFromGitUrl(data.project.git_url);
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const readiness = data.publicationReadiness;
  const local = readiness.mode === "local";
  const StatusIcon = readiness.ready ? CheckCircle2 : TriangleAlert;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="project-publication-trigger nowheel nodrag"
        onClick={() => setOpen(true)}
      >
        <span className="node-icon">
          {local ? <Github size={20} /> : <StatusIcon size={20} />}
        </span>
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
      {open
        ? createPortal(
            <dialog
              ref={dialogRef}
              className="publication-dialog"
              onClose={() => setOpen(false)}
              onClick={() => setOpen(false)}
            >
              <div
                className="publication-dialog__panel"
                onClick={(event) => event.stopPropagation()}
              >
                <header>
                  <StatusIcon size={20} />
                  <div>
                    <strong>{readiness.summary}</strong>
                    <span title={data.project.git_url}>
                      {data.project.git_url
                        ? shortenGitUrl(data.project.git_url)
                        : "当前仓库未配置 origin"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="关闭发布检查"
                  >
                    <X size={16} />
                  </button>
                </header>
                {readiness.issues.length > 0 ? (
                  <>
                    <h3>需要处理</h3>
                    <ul className="publication-dialog__issues">
                      {readiness.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                    <p className="publication-dialog__restart">
                      处理完成后请重启应用，启动时会重新检查。
                    </p>
                  </>
                ) : null}
                {readiness.notes.length > 0 ? (
                  <>
                    <h3>说明</h3>
                    <ul>
                      {readiness.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {githubUrl ? (
                  <a href={githubUrl} target="_blank" rel="noreferrer">
                    打开 GitHub 仓库
                  </a>
                ) : null}
              </div>
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}
