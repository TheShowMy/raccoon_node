import React, { useState } from "react";
import { FolderPlus } from "lucide-react";
import type { StartNodeData } from "../../types/api";

export default function CreateProjectNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "create" }>;
}) {
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await data.onCreate(name, gitUrl);
    setName("");
    setGitUrl("");
  }

  return (
    <>
      <div className="node-header node-header--create">
        <span className="node-icon">
          <FolderPlus size={20} />
        </span>
        <div>
          <strong>新建项目</strong>
          <span>创建一个新的项目节点</span>
        </div>
      </div>
      <form className="create-form" onSubmit={submit}>
        <input
          id="project-name"
          name="project-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="项目名称"
          aria-label="项目名称"
        />
        <input
          id="project-git-url"
          name="project-git-url"
          className="create-form__git"
          value={gitUrl}
          onChange={(event) => setGitUrl(event.target.value)}
          placeholder="Git 链接"
          aria-label="Git 链接"
        />
        <button type="submit" disabled={data.busy}>
          {data.busy ? "克隆中" : "创建"}
        </button>
      </form>
      {data.error ? <p className="form-error">{data.error}</p> : null}
    </>
  );
}
