import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  Edge,
  Handle,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import {
  Check,
  ChevronDown,
  FolderPlus,
  ListTree,
  Settings,
  SlidersHorizontal,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./styles.css";

const nodeTypes = { startNode: StartNode };
const PROJECT_LIST_WIDTH = 420;
const PROJECT_ITEM_WIDTH = 348;
const PROJECT_ITEM_HEIGHT = 86;
const PROJECT_ITEM_TOP = 148;
const PROJECT_ITEM_GAP = 12;
const PROJECT_LIST_Y = 320;
const DELETE_CONFIRM_MIN_Y = 80;
const DELETE_CONFIRM_MAX_Y = 320;

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
  model_settings: ModelSettings;
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ModelTierKey = "low" | "medium" | "high";

type ModelTierSetting = {
  model_id: string | null;
  thinking_level: ThinkingLevel;
};

type ModelSettings = Record<ModelTierKey, ModelTierSetting>;

type PiModel = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
};

type ModelSettingsResponse = {
  models: PiModel[];
  settings: ModelSettings;
  rpc_status: "ready" | "error";
  rpc_error: string | null;
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
      projectCount: number;
    }
  | {
      kind: "project-item";
      project: Project;
      deletingId: string | null;
      pendingDeleteProjectId: string | null;
      onDeleteRequest: (project: Project) => void;
    }
  | {
      kind: "delete-confirm";
      project: Project;
      deleting: boolean;
      error: string | null;
      onCancel: () => void;
      onConfirm: (project: Project) => Promise<void>;
    }
  | {
      kind: "model-config";
      settings: ModelSettings;
      models: PiModel[];
      rpcStatus: "idle" | "loading" | "ready" | "error";
      error: string | null;
      saving: boolean;
      onChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
      onClose: () => void;
      onSave: () => Promise<void>;
    }
  | {
      kind: "summary";
      title: string;
      description: string;
      icon: "settings" | "model";
      actionLabel?: string;
      onAction?: () => void;
    };

const emptyStartData: StartData = {
  projects: [],
  settings_summary: {
    title: "设置",
    description: "基础设置待配置",
  },
  model_summary: {
    title: "模型设置",
    description: "默认模型待配置",
  },
  model_settings: defaultModelSettings(),
};

const tierLabels: Record<ModelTierKey, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

const thinkingLevels: Array<{ value: ThinkingLevel; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

function StartNode({ data }: NodeProps<Node<StartNodeData>>) {
  const isPendingDelete =
    data.kind === "project-item" &&
    data.pendingDeleteProjectId === data.project.id;
  const hasFlowLeftHandle = data.kind === "create" || data.kind === "projects";
  const hasModelSourceHandle = data.kind === "summary" && data.icon === "model";
  const hasModelTargetHandle = data.kind === "model-config";
  const hasDeleteRightHandle = data.kind === "project-item";
  const hasDeleteLeftHandle = data.kind === "delete-confirm";

  return (
    <div
      className={`node-card node-card--${data.kind} ${
        isPendingDelete ? "node-card--pending-delete" : ""
      }`}
    >
      {hasFlowLeftHandle ? (
        <Handle
          id="left-link"
          type={data.kind === "create" ? "source" : "target"}
          position={Position.Left}
          className="node-link-handle node-link-handle--flow"
        />
      ) : null}
      {hasDeleteLeftHandle ? (
        <Handle
          id="delete-left"
          type="target"
          position={Position.Left}
          className="node-link-handle node-link-handle--danger"
        />
      ) : null}
      {hasModelTargetHandle ? (
        <Handle
          id="model-right"
          type="target"
          position={Position.Right}
          className="node-link-handle node-link-handle--model"
        />
      ) : null}
      {data.kind === "create" ? <CreateProjectNode data={data} /> : null}
      {data.kind === "projects" ? (
        <ProjectListNode projectCount={data.projectCount} />
      ) : null}
      {data.kind === "project-item" ? <ProjectItemNode data={data} /> : null}
      {data.kind === "delete-confirm" ? (
        <DeleteConfirmNode data={data} />
      ) : null}
      {data.kind === "model-config" ? <ModelConfigNode data={data} /> : null}
      {data.kind === "summary" ? <SummaryCard data={data} /> : null}
      {hasDeleteRightHandle ? (
        <Handle
          id="delete-right"
          type="source"
          position={Position.Right}
          className="node-link-handle node-link-handle--danger"
        />
      ) : null}
      {hasModelSourceHandle ? (
        <Handle
          id="model-left-source"
          type="source"
          position={Position.Left}
          className="node-link-handle node-link-handle--model"
        />
      ) : null}
    </div>
  );
}

function CreateProjectNode({
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

function ProjectListNode({ projectCount }: { projectCount: number }) {
  return (
    <>
      <div className="node-header node-header--projects">
        <span className="node-icon">
          <ListTree size={20} />
        </span>
        <div>
          <strong>项目列表</strong>
          <span>{projectCount} 个项目</span>
        </div>
      </div>
      {projectCount === 0 ? (
        <div className="empty-state">暂无项目</div>
      ) : (
        <div className="project-summary">
          <strong>{projectCount}</strong>
        </div>
      )}
    </>
  );
}

function getProjectListHeight(projectCount: number) {
  if (projectCount === 0) {
    return 220;
  }

  return (
    PROJECT_ITEM_TOP +
    projectCount * PROJECT_ITEM_HEIGHT +
    (projectCount - 1) * PROJECT_ITEM_GAP +
    28
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function ProjectItemNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "project-item" }>;
}) {
  const isPendingDelete = data.pendingDeleteProjectId === data.project.id;

  return (
    <>
      <div className="project-item-node__header">
        <button className="project-item-node__main" type="button">
          <span>{data.project.name}</span>
          <small title={data.project.git_url}>
            {shortenGitUrl(data.project.git_url)}
          </small>
          <small>更新于 {formatDate(data.project.updated_at)}</small>
        </button>
        <button
          className="project-item-node__delete"
          type="button"
          disabled={data.deletingId === data.project.id || isPendingDelete}
          aria-label={`删除项目 ${data.project.name}`}
          onClick={() => data.onDeleteRequest(data.project)}
          title="删除项目"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </>
  );
}

function FitViewOnGraphChange({
  nodeCount,
  edgeCount,
}: {
  nodeCount: number;
  edgeCount: number;
}) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.16, duration: 260 });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [edgeCount, fitView, nodeCount]);

  return null;
}

function DeleteConfirmNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "delete-confirm" }>;
}) {
  return (
    <>
      <div className="node-header node-header--danger">
        <span className="node-icon">
          <TriangleAlert size={20} />
        </span>
        <div>
          <strong>删除项目</strong>
          <span>确认该项目 item</span>
        </div>
      </div>
      <div className="delete-detail">
        <div>
          <span>项目名称</span>
          <strong title={data.project.name}>{data.project.name}</strong>
        </div>
        <div>
          <span>Git 链接</span>
          <strong title={data.project.git_url}>
            {shortenGitUrl(data.project.git_url)}
          </strong>
        </div>
        <div>
          <span>本地路径</span>
          <strong title={data.project.local_path}>
            {data.project.local_path}
          </strong>
        </div>
        <div>
          <span>更新时间</span>
          <strong>{formatDate(data.project.updated_at)}</strong>
        </div>
      </div>
      <p className="delete-warning">
        将删除该项目记录、本地克隆目录和相关资源。
      </p>
      {data.error ? <p className="form-error">{data.error}</p> : null}
      <div className="delete-actions">
        <button
          className="delete-actions__cancel"
          type="button"
          disabled={data.deleting}
          onClick={data.onCancel}
        >
          取消
        </button>
        <button
          className="delete-actions__confirm"
          type="button"
          disabled={data.deleting}
          onClick={() => void data.onConfirm(data.project)}
        >
          {data.deleting ? "删除中" : "删除"}
        </button>
      </div>
    </>
  );
}

type ModelSelectOption = {
  value: string;
  label: string;
};

type ModelSelectProps = {
  value: string;
  options: ModelSelectOption[];
  disabled?: boolean;
  placeholder?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onChange: (value: string) => void;
};

function ModelSelect({
  value,
  options,
  disabled,
  placeholder,
  open: openProp,
  onOpenChange,
  onChange,
}: ModelSelectProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? placeholder ?? "";

  function setOpen(nextOpen: boolean) {
    if (!isControlled) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }

  useEffect(() => {
    if (open) {
      const index = options.findIndex((option) => option.value === value);
      setHighlightedIndex(index >= 0 ? index : 0);
    }
  }, [open, options, value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as globalThis.Node)
      ) {
        setOpen(false);
      }
    }

    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  function toggle() {
    if (!disabled) {
      setOpen(!open);
    }
  }

  function select(option: ModelSelectOption) {
    onChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && options[highlightedIndex]) {
        select(options[highlightedIndex]);
      } else {
        setOpen(true);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        setHighlightedIndex((previous) => (previous + 1) % options.length);
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        setHighlightedIndex(
          (previous) => (previous - 1 + options.length) % options.length,
        );
      }
    }
  }

  return (
    <div className="model-select" ref={containerRef}>
      <button
        type="button"
        className={`model-select__trigger ${
          open ? "model-select__trigger--open" : ""
        }`}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selectedLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <ul className="model-select__dropdown" role="listbox">
          {options.map((option, index) => (
            <li
              key={option.value}
              className={`model-select__option ${
                option.value === value ? "model-select__option--selected" : ""
              } ${
                index === highlightedIndex
                  ? "model-select__option--highlighted"
                  : ""
              }`}
              role="option"
              aria-selected={option.value === value}
              onClick={() => select(option)}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              {option.value === value ? <Check size={14} /> : null}
              <span>{option.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ModelConfigNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "model-config" }>;
}) {
  const noModels = data.rpcStatus === "ready" && data.models.length === 0;
  const disabled = data.rpcStatus !== "ready" || data.models.length === 0;
  const [openSelectId, setOpenSelectId] = useState<string | null>(null);

  return (
    <>
      <div className="node-header node-header--model">
        <span className="node-icon">
          <SlidersHorizontal size={20} />
        </span>
        <div>
          <strong>模型配置</strong>
          <span>{modelStatusText(data.rpcStatus)}</span>
        </div>
      </div>
      {noModels ? (
        <p className="model-notice">
          Pi Agent 中还没有已配置模型，请先在 Pi Agent 中完成模型配置。
        </p>
      ) : null}
      {data.error ? <p className="form-error">{data.error}</p> : null}
      <div className="model-config-grid">
        {(["low", "medium", "high"] as ModelTierKey[]).map((tier) => {
          const setting = data.settings[tier];
          const modelSelectId = `${tier}-model`;
          const thinkingSelectId = `${tier}-thinking`;

          return (
            <section className="model-config-tier" key={tier}>
              <strong>{tierLabels[tier]}档</strong>
              <label>
                <span>模型</span>
                <ModelSelect
                  value={setting.model_id ?? ""}
                  disabled={disabled}
                  placeholder="选择模型"
                  open={openSelectId === modelSelectId}
                  onOpenChange={(isOpen) =>
                    setOpenSelectId(isOpen ? modelSelectId : null)
                  }
                  options={[
                    { value: "", label: "选择模型" },
                    ...data.models.map((model) => ({
                      value: model.id,
                      label: `${model.provider}/${model.name}`,
                    })),
                  ]}
                  onChange={(value) =>
                    data.onChange(tier, {
                      ...setting,
                      model_id: value || null,
                    })
                  }
                />
              </label>
              <label>
                <span>思考强度</span>
                <ModelSelect
                  value={setting.thinking_level}
                  disabled={disabled}
                  open={openSelectId === thinkingSelectId}
                  onOpenChange={(isOpen) =>
                    setOpenSelectId(isOpen ? thinkingSelectId : null)
                  }
                  options={thinkingLevels.map((level) => ({
                    value: level.value,
                    label: level.label,
                  }))}
                  onChange={(value) =>
                    data.onChange(tier, {
                      ...setting,
                      thinking_level: value as ThinkingLevel,
                    })
                  }
                />
              </label>
            </section>
          );
        })}
      </div>
      <div className="model-actions">
        <button
          className="model-actions__close"
          type="button"
          disabled={data.saving}
          onClick={data.onClose}
        >
          关闭
        </button>
        <button
          className="model-actions__save"
          type="button"
          disabled={
            data.saving ||
            data.rpcStatus !== "ready" ||
            data.models.length === 0
          }
          onClick={() => void data.onSave()}
        >
          {data.saving ? "保存中" : "保存"}
        </button>
      </div>
    </>
  );
}

function SummaryCard({
  data,
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
      <button className="ghost-button" type="button" onClick={data.onAction}>
        {data.actionLabel ?? "查看摘要"}
      </button>
    </>
  );
}

function App() {
  const [startData, setStartData] = useState<StartData>(emptyStartData);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeleteProject, setPendingDeleteProject] =
    useState<Project | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [models, setModels] = useState<PiModel[]>([]);
  const [draftModelSettings, setDraftModelSettings] = useState<ModelSettings>(
    defaultModelSettings(),
  );
  const [modelRpcStatus, setModelRpcStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [modelError, setModelError] = useState<string | null>(null);
  const [savingModels, setSavingModels] = useState(false);

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

  const loadModelSettings = useCallback(async () => {
    setModelRpcStatus("loading");
    setModelError(null);

    try {
      const response = await fetch("/api/settings/models");
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? "读取模型设置失败");
      }

      const data = (await response.json()) as ModelSettingsResponse;
      setModels(data.models);
      setDraftModelSettings(data.settings);
      setModelRpcStatus(data.rpc_status);
      setModelError(data.rpc_error);
    } catch (reason) {
      setModels([]);
      setModelRpcStatus("error");
      setModelError(readError(reason));
    }
  }, []);

  const openModelSettings = useCallback(() => {
    setModelSettingsOpen(true);
    void loadModelSettings();
  }, [loadModelSettings]);

  const updateModelTier = useCallback(
    (tier: ModelTierKey, setting: ModelTierSetting) => {
      setDraftModelSettings((current) => ({
        ...current,
        [tier]: setting,
      }));
    },
    [],
  );

  const saveModelSettings = useCallback(async () => {
    setSavingModels(true);
    setModelError(null);

    try {
      const response = await fetch("/api/settings/models", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draftModelSettings),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? "保存模型设置失败");
      }

      const data = (await response.json()) as ModelSettingsResponse;
      setModels(data.models);
      setDraftModelSettings(data.settings);
      setModelRpcStatus(data.rpc_status);
      setModelError(data.rpc_error);
      await loadStart();
      setModelSettingsOpen(false);
    } catch (reason) {
      setModelError(readError(reason));
    } finally {
      setSavingModels(false);
    }
  }, [draftModelSettings, loadStart]);

  const createProject = useCallback(
    async (name: string, gitUrl: string) => {
      setCreating(true);
      setError(null);

      try {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name, git_url: gitUrl }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            message?: string;
          } | null;
          throw new Error(body?.message ?? "创建项目失败");
        }

        await loadStart();
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setCreating(false);
      }
    },
    [loadStart],
  );

  const requestDeleteProject = useCallback((project: Project) => {
    setPendingDeleteProject(project);
    setDeleteError(null);
  }, []);

  const cancelDeleteProject = useCallback(() => {
    setPendingDeleteProject(null);
    setDeleteError(null);
  }, []);

  const confirmDeleteProject = useCallback(
    async (project: Project) => {
      setDeletingId(project.id);
      setDeleteError(null);

      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(project.id)}`,
          {
            method: "DELETE",
          },
        );

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            message?: string;
          } | null;
          throw new Error(body?.message ?? "删除项目失败");
        }

        await loadStart();
        setPendingDeleteProject(null);
      } catch (reason) {
        setDeleteError(readError(reason));
      } finally {
        setDeletingId(null);
      }
    },
    [loadStart],
  );

  const nodes = useMemo<Node<StartNodeData>[]>(() => {
    const projectListHeight = getProjectListHeight(startData.projects.length);

    const baseNodes: Node<StartNodeData>[] = [
      {
        id: "settings",
        type: "startNode",
        position: { x: 80, y: 80 },
        data: {
          kind: "summary",
          icon: "settings",
          title: startData.settings_summary.title,
          description: startData.settings_summary.description,
          actionLabel: "打开设置",
          onAction: openModelSettings,
        },
      },
      {
        id: "model-settings",
        type: "startNode",
        position: { x: 80, y: 245 },
        data: {
          kind: "summary",
          icon: "model",
          title: startData.model_summary.title,
          description: startData.model_summary.description,
          actionLabel: "配置模型",
          onAction: openModelSettings,
        },
      },
      {
        id: "create-project",
        type: "startNode",
        position: { x: 390, y: 80 },
        data: {
          kind: "create",
          onCreate: createProject,
          busy: creating,
          error,
        },
      },
      {
        id: "project-list",
        type: "startNode",
        position: { x: 390, y: PROJECT_LIST_Y },
        style: {
          width: PROJECT_LIST_WIDTH,
          height: projectListHeight,
        },
        data: {
          kind: "projects",
          projectCount: startData.projects.length,
        },
      },
    ];

    startData.projects.forEach((project, index) => {
      baseNodes.push({
        id: `project-item-${project.id}`,
        type: "startNode",
        parentId: "project-list",
        extent: "parent",
        position: {
          x: 36,
          y:
            PROJECT_ITEM_TOP + index * (PROJECT_ITEM_HEIGHT + PROJECT_ITEM_GAP),
        },
        style: {
          width: PROJECT_ITEM_WIDTH,
          height: PROJECT_ITEM_HEIGHT,
        },
        data: {
          kind: "project-item",
          project,
          deletingId,
          pendingDeleteProjectId: pendingDeleteProject?.id ?? null,
          onDeleteRequest: requestDeleteProject,
        },
      });
    });

    if (pendingDeleteProject) {
      const projectIndex = startData.projects.findIndex(
        (project) => project.id === pendingDeleteProject.id,
      );

      baseNodes.push({
        id: `delete-confirm-${pendingDeleteProject.id}`,
        type: "startNode",
        position: {
          x: 860,
          y: clamp(
            PROJECT_LIST_Y +
              PROJECT_ITEM_TOP +
              Math.max(projectIndex, 0) *
                (PROJECT_ITEM_HEIGHT + PROJECT_ITEM_GAP),
            DELETE_CONFIRM_MIN_Y,
            DELETE_CONFIRM_MAX_Y,
          ),
        },
        data: {
          kind: "delete-confirm",
          project: pendingDeleteProject,
          deleting: deletingId === pendingDeleteProject.id,
          error: deleteError,
          onCancel: cancelDeleteProject,
          onConfirm: confirmDeleteProject,
        },
      });
    }

    if (modelSettingsOpen) {
      baseNodes.push({
        id: "model-config",
        type: "startNode",
        position: { x: -320, y: 80 },
        data: {
          kind: "model-config",
          settings: draftModelSettings,
          models,
          rpcStatus: modelRpcStatus,
          error: modelError,
          saving: savingModels,
          onChange: updateModelTier,
          onClose: () => setModelSettingsOpen(false),
          onSave: saveModelSettings,
        },
      });
    }

    return baseNodes;
  }, [
    cancelDeleteProject,
    confirmDeleteProject,
    createProject,
    creating,
    deleteError,
    deletingId,
    draftModelSettings,
    error,
    modelError,
    modelRpcStatus,
    modelSettingsOpen,
    models,
    pendingDeleteProject,
    requestDeleteProject,
    saveModelSettings,
    savingModels,
    setModelSettingsOpen,
    startData,
    openModelSettings,
    updateModelTier,
  ]);

  const edges = useMemo<Edge[]>(() => {
    const flowEdges: Edge[] = [
      {
        id: "create-project-to-project-list",
        source: "create-project",
        sourceHandle: "left-link",
        target: "project-list",
        targetHandle: "left-link",
        type: "smoothstep",
        animated: true,
        style: {
          stroke: "rgba(20, 184, 166, 0.56)",
          strokeWidth: 2,
        },
      },
    ];

    if (pendingDeleteProject) {
      flowEdges.push({
        id: `project-item-delete-confirm-${pendingDeleteProject.id}`,
        source: `project-item-${pendingDeleteProject.id}`,
        sourceHandle: "delete-right",
        target: `delete-confirm-${pendingDeleteProject.id}`,
        targetHandle: "delete-left",
        type: "smoothstep",
        animated: true,
        style: {
          stroke: "rgba(251, 113, 133, 0.72)",
          strokeDasharray: "6 6",
          strokeWidth: 2,
        },
      });
    }

    if (modelSettingsOpen) {
      flowEdges.push({
        id: "model-settings-to-model-config",
        source: "model-settings",
        sourceHandle: "model-left-source",
        target: "model-config",
        targetHandle: "model-right",
        type: "smoothstep",
        animated: true,
        style: {
          stroke: "rgba(249, 115, 22, 0.68)",
          strokeWidth: 2,
        },
      });
    }

    return flowEdges;
  }, [modelSettingsOpen, pendingDeleteProject]);

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
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.16 }}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
          >
            <Background color="rgba(148, 163, 184, 0.18)" gap={24} />
            <Controls position="bottom-right" />
            <FitViewOnGraphChange
              nodeCount={nodes.length}
              edgeCount={edges.length}
            />
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
    minute: "2-digit",
  }).format(new Date(value));
}

function readError(reason: unknown) {
  return reason instanceof Error ? reason.message : "未知错误";
}

function shortenGitUrl(value: string) {
  return value.replace(/^git@([^:]+):/, "$1/").replace(/^https?:\/\//, "");
}

function defaultModelSettings(): ModelSettings {
  return {
    low: { model_id: null, thinking_level: "low" },
    medium: { model_id: null, thinking_level: "medium" },
    high: { model_id: null, thinking_level: "high" },
  };
}

function modelStatusText(status: "idle" | "loading" | "ready" | "error") {
  if (status === "loading") {
    return "正在读取 Pi Agent 模型";
  }
  if (status === "ready") {
    return "Pi Agent RPC 已连接";
  }
  if (status === "error") {
    return "Pi Agent RPC 异常";
  }
  return "等待加载";
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
