import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  Handle,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider
} from "@xyflow/react";
import { FolderPlus, ListTree, Settings, SlidersHorizontal, Trash2 } from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./styles.css";

type Project = {
  id: string;
  name: string;
  git_url: string;
  local_path: string;
  created_at: string;
  updated_at: string;
};

type SummaryNode = {
  title: string;
  description: string;
};

type StartData = {
  projects: Project[];
  settings_summary: SummaryNode;
  model_summary: SummaryNode;
};

type StartNodeData =
  | {
      kind: "create";
      onCreate: (name: string, gitUrl: string) => Promise<void>;
      busy: boolean;
      error: string | null;
    }
  | {
      kind: "projects";
      projects: Project[];
      deletingId: string | null;
      onDelete: (project: Project) => Promise<void>;
    }
  | {
      kind: "summary";
      title: string;
      description: string;
      icon: "settings" | "model";
    };

const emptyStartData: StartData = {
  projects: [],
  settings_summary: {
    title: "设置",
    description: "基础设置待配置"
  },
  model_summary: {
    title: "模型设置",
    description: "默认模型待配置"
  }
};

function StartNode({ data }: NodeProps<Node<StartNodeData>>) {
  return (
    <div className={`node-card node-card--${data.kind}`}>
      <Handle type="target" position={Position.Left} className="hidden-handle" />
      {data.kind === "create" ? <CreateProjectNode data={data} /> : null}
      {data.kind === "projects" ? (
        <ProjectListNode
          projects={data.projects}
          deletingId={data.deletingId}
          onDelete={data.onDelete}
        />
      ) : null}
      {data.kind === "summary" ? <SummaryCard data={data} /> : null}
      <Handle type="source" position={Position.Right} className="hidden-handle" />
    </div>
  );
}

function CreateProjectNode({
  data
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
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="项目名称"
          aria-label="项目名称"
        />
        <input
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

function ProjectListNode({
  projects,
  deletingId,
  onDelete
}: {
  projects: Project[];
  deletingId: string | null;
  onDelete: (project: Project) => Promise<void>;
}) {
  return (
    <>
      <div className="node-header node-header--projects">
        <span className="node-icon">
          <ListTree size={20} />
        </span>
        <div>
          <strong>项目列表</strong>
          <span>{projects.length} 个项目</span>
        </div>
      </div>
      <div className="project-list">
        {projects.length === 0 ? (
          <div className="empty-state">暂无项目</div>
        ) : (
          projects.map((project) => (
            <div className="project-item" key={project.id}>
              <button className="project-item__main" type="button">
                <span>{project.name}</span>
                <small title={project.git_url}>{shortenGitUrl(project.git_url)}</small>
                <small>更新于 {formatDate(project.updated_at)}</small>
              </button>
              <button
                className="project-item__delete"
                type="button"
                disabled={deletingId === project.id}
                aria-label={`删除项目 ${project.name}`}
                onClick={() => void onDelete(project)}
                title="删除项目"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function SummaryCard({
  data
}: {
  data: Extract<StartNodeData, { kind: "summary" }>;
}) {
  const Icon = data.icon === "settings" ? Settings : SlidersHorizontal;
  return (
    <>
      <div className={`node-header node-header--${data.icon}`}>
        <span className="node-icon">
          <Icon size={20} />
        </span>
        <div>
          <strong>{data.title}</strong>
          <span>{data.description}</span>
        </div>
      </div>
      <button className="ghost-button" type="button">
        查看摘要
      </button>
    </>
  );
}

function App() {
  const [startData, setStartData] = useState<StartData>(emptyStartData);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStart = useCallback(async () => {
    const response = await fetch("/api/start");
    if (!response.ok) {
      throw new Error("读取 start 数据失败");
    }
    setStartData(await response.json());
  }, []);

  useEffect(() => {
    loadStart()
      .catch((reason: unknown) => setError(readError(reason)))
      .finally(() => setLoading(false));
  }, [loadStart]);

  const createProject = useCallback(
    async (name: string, gitUrl: string) => {
      setCreating(true);
      setError(null);

      try {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name, git_url: gitUrl })
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? "创建项目失败");
        }

        await loadStart();
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setCreating(false);
      }
    },
    [loadStart]
  );

  const deleteProject = useCallback(
    async (project: Project) => {
      const confirmed = window.confirm(
        `确定删除项目「${project.name}」吗？\n\n这会删除本地克隆目录和相关资源，操作不可撤销。`
      );
      if (!confirmed) {
        return;
      }

      setDeletingId(project.id);
      setError(null);

      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
          method: "DELETE"
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? "删除项目失败");
        }

        await loadStart();
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setDeletingId(null);
      }
    },
    [loadStart]
  );

  const nodes = useMemo<Node<StartNodeData>[]>(
    () => [
      {
        id: "settings",
        type: "startNode",
        position: { x: 80, y: 80 },
        data: {
          kind: "summary",
          icon: "settings",
          title: startData.settings_summary.title,
          description: startData.settings_summary.description
        }
      },
      {
        id: "model-settings",
        type: "startNode",
        position: { x: 80, y: 245 },
        data: {
          kind: "summary",
          icon: "model",
          title: startData.model_summary.title,
          description: startData.model_summary.description
        }
      },
      {
        id: "create-project",
        type: "startNode",
        position: { x: 80, y: 410 },
        data: {
          kind: "create",
          onCreate: createProject,
          busy: creating,
          error
        }
      },
      {
        id: "project-list",
        type: "startNode",
        position: { x: 400, y: 80 },
        data: {
          kind: "projects",
          projects: startData.projects,
          deletingId,
          onDelete: deleteProject
        }
      }
    ],
    [createProject, creating, deleteProject, deletingId, error, startData]
  );

  return (
    <main className="app-shell">
      <section className="toolbar">
        <div>
          <h1>Raccoon Node</h1>
          <p>Start 画布</p>
        </div>
        <div className="status-pill">{loading ? "加载中" : "已连接"}</div>
      </section>
      <section className="canvas-shell">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={[]}
            nodeTypes={{ startNode: StartNode }}
            fitView
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
          >
            <Background color="rgba(148, 163, 184, 0.18)" gap={24} />
            <Controls position="bottom-right" />
          </ReactFlow>
        </ReactFlowProvider>
      </section>
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function readError(reason: unknown) {
  return reason instanceof Error ? reason.message : "未知错误";
}

function shortenGitUrl(value: string) {
  return value.replace(/^git@([^:]+):/, "$1/").replace(/^https?:\/\//, "");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
