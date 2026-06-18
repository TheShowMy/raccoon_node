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
  ArrowLeft,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileQuestion,
  FolderPlus,
  ListTree,
  Loader2,
  MessageSquare,
  Moon,
  Send,
  SlidersHorizontal,
  SunMedium,
  TriangleAlert,
  Trash2,
  Wrench,
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
const THEME_STORAGE_KEY = "raccoon-node-theme";

type ThemeMode = "dark" | "light";

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

type RequirementStatus =
  | "analyzing"
  | "clarifying"
  | "draft_ready"
  | "queued"
  | "running"
  | "completed"
  | "failed";

type RequirementMessage = {
  role: "user" | "assistant" | "system" | "trace";
  content: string;
  metadata?: TraceMetadata | null;
  created_at: string;
};

type RequirementDraft = {
  title: string;
  summary: string;
  acceptance_criteria: string[];
};

type Requirement = {
  id: string;
  project_id: string;
  title: string;
  original_message: string;
  status: RequirementStatus;
  messages: RequirementMessage[];
  clarification_round: number;
  clarifications: RequirementClarification[];
  draft: RequirementDraft | null;
  pi_session_file: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectCanvasData = {
  project: Project;
  active_requirement: Requirement | null;
  queued_requirements: Requirement[];
  completed_requirements: Requirement[];
};

type ClarificationQuestionType = "single_choice" | "multi_choice" | "free_text";

type ClarificationOption = {
  value: string;
  label: string;
  description: string;
  recommended: boolean;
};

type ClarificationAnswer = {
  selected_options: string[];
  custom_text: string | null;
};

type RequirementClarification = {
  id: string;
  question: string;
  question_type: ClarificationQuestionType;
  options: ClarificationOption[];
  answer: ClarificationAnswer | null;
};

type DraftClarificationAnswer = {
  selectedOptions: string[];
  customText: string;
};

type StreamEvent = {
  requirement_id: string;
  event: string;
  message: string;
  pi_type?: string;
  payload?: unknown;
};

type TraceTool = {
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error" | string;
  output: string;
  isError?: boolean;
};

type TraceData = {
  thinking: string;
  output: string;
  tools: TraceTool[];
  statuses: Array<{ type: string; message: string }>;
};

type TraceMetadata = {
  type: "pi_trace";
  version: number;
  trace: TraceData;
};

type LiveBubble = {
  id: string;
  type: "thinking" | "tool" | "output" | "status";
  label: string;
  content: string;
  toolName?: string;
  status: "running" | "done" | "error";
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
      onOpenProject: (project: Project) => void;
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
      kind: "style-settings";
      theme: ThemeMode;
      onThemeChange: (theme: ThemeMode) => void;
    }
  | {
      kind: "summary";
      title: string;
      description: string;
      icon: "model";
      actionLabel?: string;
      onAction?: () => void;
    }
  | {
      kind: "project-back";
      project: Project;
      onBack: () => void;
    }
  | {
      kind: "requirement-list";
      title: string;
      description: string;
      requirements: Requirement[];
      emptyText: string;
      tone: "done" | "pending";
    }
  | {
      kind: "requirement-chat";
      project: Project;
      requirement: Requirement | null;
      input: string;
      busy: boolean;
      error: string | null;
      streamEvents: StreamEvent[];
      answers: Record<string, DraftClarificationAnswer>;
      onInputChange: (value: string) => void;
      onSend: () => Promise<void>;
      onAnswerChange: (
        clarification: RequirementClarification,
        answer: DraftClarificationAnswer,
      ) => void;
      onSubmitClarifications: (requirement: Requirement) => Promise<void>;
      onConfirm: (requirement: Requirement) => Promise<void>;
    };

const emptyStartData: StartData = {
  projects: [],
  settings_summary: {
    title: "样式设置",
    description: "暗色主题",
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
  const clickableAction =
    data.kind === "summary"
      ? data.onAction
      : data.kind === "project-back"
        ? data.onBack
        : undefined;
  const hasFlowLeftHandle = data.kind === "create" || data.kind === "projects";
  const hasModelSourceHandle = data.kind === "summary" && data.icon === "model";
  const hasModelTargetHandle = data.kind === "model-config";
  const hasDeleteRightHandle = data.kind === "project-item";
  const hasDeleteLeftHandle = data.kind === "delete-confirm";

  return (
    <div
      className={`node-card node-card--${data.kind} ${
        isPendingDelete ? "node-card--pending-delete" : ""
      } ${clickableAction ? "node-card--clickable" : ""}`}
      role={clickableAction ? "button" : undefined}
      tabIndex={clickableAction ? 0 : undefined}
      onClick={clickableAction}
      onKeyDown={(event) => {
        if (!clickableAction) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          clickableAction();
        }
      }}
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
          id="model-left"
          type="target"
          position={Position.Left}
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
      {data.kind === "style-settings" ? (
        <StyleSettingsNode data={data} />
      ) : null}
      {data.kind === "summary" ? <SummaryCard data={data} /> : null}
      {data.kind === "project-back" ? <ProjectBackNode data={data} /> : null}
      {data.kind === "requirement-list" ? (
        <RequirementListNode data={data} />
      ) : null}
      {data.kind === "requirement-chat" ? (
        <RequirementChatNode data={data} />
      ) : null}
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
        <button
          className="project-item-node__main"
          type="button"
          onClick={() => data.onOpenProject(data.project)}
        >
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
  return (
    <>
      <div className={`node-header node-header--${data.icon}`}>
        <span className="node-icon">
          <SlidersHorizontal size={20} />
        </span>
        <div>
          <strong>{data.title}</strong>
          <span>{data.description}</span>
        </div>
      </div>
    </>
  );
}

function StyleSettingsNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "style-settings" }>;
}) {
  return (
    <>
      <div className="node-header node-header--style">
        <span className="node-icon">
          {data.theme === "dark" ? <Moon size={20} /> : <SunMedium size={20} />}
        </span>
        <div>
          <strong>样式设置</strong>
          <span>{data.theme === "dark" ? "暗色主题" : "护眼亮色主题"}</span>
        </div>
      </div>
      <div className="theme-switcher" aria-label="样式主题">
        <button
          className={
            data.theme === "light" ? "theme-switcher__item--active" : ""
          }
          type="button"
          onClick={() => data.onThemeChange("light")}
        >
          <SunMedium size={14} />
          亮色
        </button>
        <button
          className={
            data.theme === "dark" ? "theme-switcher__item--active" : ""
          }
          type="button"
          onClick={() => data.onThemeChange("dark")}
        >
          <Moon size={14} />
          暗色
        </button>
      </div>
    </>
  );
}

function ProjectBackNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "project-back" }>;
}) {
  return (
    <>
      <div className="node-header node-header--projects">
        <span className="node-icon">
          <ArrowLeft size={20} />
        </span>
        <div>
          <strong>返回 Start</strong>
          <span>{data.project.name}</span>
        </div>
      </div>
    </>
  );
}

function RequirementListNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-list" }>;
}) {
  const Icon = data.tone === "done" ? CheckCircle2 : Clock;
  return (
    <>
      <div
        className={`node-header ${
          data.tone === "done" ? "node-header--projects" : "node-header--create"
        }`}
      >
        <span className="node-icon">
          <Icon size={20} />
        </span>
        <div>
          <strong>{data.title}</strong>
          <span>{data.description}</span>
        </div>
      </div>
      {data.requirements.length === 0 ? (
        <div className="empty-state">{data.emptyText}</div>
      ) : (
        <div className="requirement-list">
          {data.requirements.map((requirement) => (
            <div className="requirement-list__item" key={requirement.id}>
              <strong>{requirement.title}</strong>
              <span>{requirementStatusText(requirement.status)}</span>
              <small>更新于 {formatDate(requirement.updated_at)}</small>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RequirementChatNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-chat" }>;
}) {
  const requirement = data.requirement;
  const canConfirm = requirement?.status === "draft_ready" && requirement.draft;
  const isAnalyzing = requirement?.status === "analyzing";
  const canSend =
    !data.busy &&
    !isAnalyzing &&
    data.input.trim().length > 0 &&
    (!requirement ||
      ["analyzing", "clarifying", "draft_ready", "failed"].includes(
        requirement.status,
      ));
  const liveBubbles = buildBubbleStreamFromEvents(data.streamEvents);
  const transientEvents = data.streamEvents.filter(
    (event) => event.event !== "pi_event",
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSend) {
      await data.onSend();
    }
  }

  return (
    <>
      <div className="node-header node-header--model">
        <span className="node-icon">
          <MessageSquare size={20} />
        </span>
        <div>
          <strong>需求</strong>
          <span>
            {requirement
              ? requirementStatusText(requirement.status)
              : "新的需求会话"}
          </span>
        </div>
      </div>
      <div className="requirement-chat">
        {requirement ? (
          <div className="requirement-messages">
            {requirement.messages.map((message) => (
              <RequirementMessageBubble
                key={`${message.role}-${message.created_at}-${message.content}`}
                message={message}
              />
            ))}
          </div>
        ) : (
          <div className="requirement-empty">
            <MessageSquare size={24} />
            <strong>新的需求会话</strong>
            <span>描述你的需求，Coordinator 会先澄清并生成确认卡片。</span>
          </div>
        )}

        {transientEvents.length > 0 ? (
          <div className="requirement-events">
            {transientEvents.map((event, index) => (
              <span key={`${event.event}-${index}`}>{event.message}</span>
            ))}
          </div>
        ) : null}

        {liveBubbles.length > 0 ? (
          <TraceBubble bubbles={liveBubbles} isLive={isAnalyzing} />
        ) : isAnalyzing ? (
          <div className="requirement-analyzing">
            <Loader2 size={16} />
            Coordinator 正在分析当前需求...
          </div>
        ) : null}

        {requirement?.status === "clarifying" &&
        requirement.clarifications.length > 0 ? (
          <ClarificationPanel
            requirement={requirement}
            answers={data.answers}
            busy={data.busy}
            onAnswerChange={data.onAnswerChange}
            onSubmit={() => void data.onSubmitClarifications(requirement)}
          />
        ) : null}

        {requirement?.draft ? (
          <div className="requirement-draft">
            <div>
              <strong>{requirement.draft.title}</strong>
              <p>{requirement.draft.summary}</p>
            </div>
            <ul>
              {requirement.draft.acceptance_criteria.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <button
              className="model-actions__save"
              type="button"
              disabled={data.busy || !canConfirm}
              onClick={() => requirement && void data.onConfirm(requirement)}
            >
              确认并加入执行队列
            </button>
          </div>
        ) : null}

        {requirement?.error ? (
          <p className="form-error">{requirement.error}</p>
        ) : null}
        {data.error ? <p className="form-error">{data.error}</p> : null}

        <form className="requirement-input" onSubmit={submit}>
          <textarea
            id="requirement-input"
            name="requirement-input"
            value={data.input}
            disabled={data.busy}
            onChange={(event) => data.onInputChange(event.target.value)}
            placeholder={
              requirement
                ? isAnalyzing
                  ? "Coordinator 正在分析，过程会实时显示..."
                  : "补充说明你的需求..."
                : "描述你的需求，Coordinator 会用聊天形式澄清..."
            }
          />
          <button type="submit" disabled={!canSend}>
            <Send size={15} />
            {data.busy ? "分析中" : "发送"}
          </button>
        </form>
      </div>
    </>
  );
}

function RequirementMessageBubble({
  message,
}: {
  message: RequirementMessage;
}) {
  const trace = traceFromMessage(message);
  if (trace) {
    return (
      <TraceBubble bubbles={buildBubbleStreamFromTrace(trace)} isLive={false} />
    );
  }

  return (
    <div className={`requirement-message requirement-message--${message.role}`}>
      <strong>{requirementMessageRoleText(message.role)}</strong>
      <p>{message.content}</p>
    </div>
  );
}

function TraceBubble({
  bubbles,
  isLive,
}: {
  bubbles: LiveBubble[];
  isLive: boolean;
}) {
  const [expanded, setExpanded] = useState(isLive);
  const contentRef = useRef<HTMLDivElement>(null);
  const running = bubbles.some((bubble) => bubble.status === "running");
  const hasError = bubbles.some((bubble) => bubble.status === "error");

  useEffect(() => {
    if (!expanded || !contentRef.current) return;
    requestAnimationFrame(() => {
      const element = contentRef.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }, [bubbles, expanded]);

  if (bubbles.length === 0) return null;

  return (
    <div className="trace-bubble">
      <button
        className="trace-bubble__header"
        type="button"
        onClick={() => setExpanded((value) => !value)}
      >
        <span>
          {running ? (
            <Loader2 size={15} className="spin-icon" />
          ) : hasError ? (
            <TriangleAlert size={15} />
          ) : (
            <CheckCircle2 size={15} />
          )}
          {running
            ? "Coordinator 正在分析..."
            : hasError
              ? "分析出错"
              : "分析过程"}
        </span>
        <span>{bubbles.length} 个气泡</span>
        <ChevronDown size={14} className={expanded ? "rotate-icon" : ""} />
      </button>
      {expanded ? (
        <div className="trace-bubble__content" ref={contentRef}>
          {bubbles.map((bubble) => (
            <TraceBubbleItem bubble={bubble} isLive={isLive} key={bubble.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TraceBubbleItem({
  bubble,
  isLive,
}: {
  bubble: LiveBubble;
  isLive: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!isLive || !preRef.current) return;
    requestAnimationFrame(() => {
      const element = preRef.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }, [bubble.content, isLive]);

  if (bubble.type === "status") {
    return (
      <div className="trace-status">
        <span />
        {bubble.label}
      </div>
    );
  }

  return (
    <div className={`trace-item trace-item--${bubble.status}`}>
      <div className="trace-item__header">
        <span>
          {bubble.type === "thinking" ? <Brain size={14} /> : null}
          {bubble.type === "tool" ? <Wrench size={14} /> : null}
          {bubble.label}
        </span>
        {!isLive ? <em>{traceStatusText(bubble.status)}</em> : null}
      </div>
      {bubble.content ? <pre ref={preRef}>{bubble.content}</pre> : null}
    </div>
  );
}

function ClarificationPanel({
  requirement,
  answers,
  busy,
  onAnswerChange,
  onSubmit,
}: {
  requirement: Requirement;
  answers: Record<string, DraftClarificationAnswer>;
  busy: boolean;
  onAnswerChange: (
    clarification: RequirementClarification,
    answer: DraftClarificationAnswer,
  ) => void;
  onSubmit: () => void;
}) {
  const [step, setStep] = useState(0);
  const items = requirement.clarifications;
  const current = items[step];
  const currentAnswer = answers[current.id] ?? createDraftAnswer(current);
  const currentAnswered = hasDraftAnswer(current, currentAnswer);
  const allAnswered = items.every((item) =>
    hasDraftAnswer(item, answers[item.id]),
  );
  const isLast = step === items.length - 1;

  // Reset to the first unanswered step when the clarification round changes.
  useEffect(() => {
    const firstUnanswered = items.findIndex(
      (item) => !hasDraftAnswer(item, answers[item.id]),
    );
    setStep(firstUnanswered === -1 ? 0 : firstUnanswered);
  }, [requirement.clarification_round]);

  function goToStep(index: number) {
    // Only allow navigating to completed steps or the current/first unanswered step.
    const target = items[index];
    if (!target || (index > step && !hasDraftAnswer(current, currentAnswer))) {
      return;
    }
    setStep(index);
  }

  function goNext() {
    if (!currentAnswered) return;
    if (isLast) {
      if (allAnswered) onSubmit();
      return;
    }
    setStep((value) => Math.min(value + 1, items.length - 1));
  }

  function goPrev() {
    setStep((value) => Math.max(value - 1, 0));
  }

  return (
    <div className="clarification-panel">
      <div className="clarification-panel__head">
        <span>
          <FileQuestion size={15} />
          需要你确认
        </span>
        <em>
          第 {requirement.clarification_round} 轮澄清 ({step + 1}/{items.length}
          )
        </em>
      </div>

      <div className="clarification-steps">
        {items.map((item, index) => {
          const answered = hasDraftAnswer(item, answers[item.id]);
          const status =
            index === step ? "current" : answered ? "completed" : "pending";
          return (
            <button
              className={`clarification-step clarification-step--${status}`}
              disabled={busy || (!answered && index !== step)}
              key={item.id}
              type="button"
              onClick={() => goToStep(index)}
            >
              {answered && index !== step ? <Check size={12} /> : index + 1}
            </button>
          );
        })}
      </div>

      <div className="clarification-panel__items">
        <ClarificationCard
          answer={currentAnswer}
          clarification={current}
          index={step}
          onChange={(answer) => onAnswerChange(current, answer)}
        />
      </div>

      <div className="clarification-panel__actions">
        <button
          className="clarification-panel__prev"
          disabled={busy || step === 0}
          type="button"
          onClick={goPrev}
        >
          <ChevronLeft size={14} />
          上一步
        </button>
        <button
          className="clarification-panel__next"
          disabled={busy || !currentAnswered}
          type="button"
          onClick={goNext}
        >
          {busy ? (
            <Loader2 size={14} className="spin-icon" />
          ) : isLast ? (
            <Send size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
          {busy ? "提交中" : isLast ? "提交澄清答案" : "下一步"}
        </button>
      </div>
    </div>
  );
}

function ClarificationCard({
  clarification,
  index,
  answer,
  onChange,
}: {
  clarification: RequirementClarification;
  index: number;
  answer: DraftClarificationAnswer;
  onChange: (answer: DraftClarificationAnswer) => void;
}) {
  const isFreeText = clarification.question_type === "free_text";

  return (
    <section className="clarification-card">
      <div className="clarification-card__question">
        <span>Q{index + 1}</span>
        <strong>{clarification.question}</strong>
      </div>
      {isFreeText ? (
        <textarea
          value={answer.customText}
          onChange={(event) =>
            onChange({ ...answer, customText: event.target.value })
          }
          placeholder="补充你的答案..."
        />
      ) : (
        <div className="clarification-options">
          {clarification.options.map((option) => {
            const checked = answer.selectedOptions.includes(option.value);
            return (
              <button
                className={checked ? "clarification-option--selected" : ""}
                key={option.value}
                type="button"
                onClick={() =>
                  onChange(
                    toggleClarificationOption(
                      clarification,
                      answer,
                      option.value,
                    ),
                  )
                }
              >
                <span>
                  {checked ? <Check size={13} /> : null}
                  {option.label}
                  {option.recommended ? <em>推荐</em> : null}
                </span>
                <small>{option.description}</small>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [startData, setStartData] = useState<StartData>(emptyStartData);
  const [currentCanvas, setCurrentCanvas] = useState<"start" | "project">(
    "start",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [projectCanvas, setProjectCanvas] = useState<ProjectCanvasData | null>(
    null,
  );
  const [requirementInput, setRequirementInput] = useState("");
  const [requirementBusy, setRequirementBusy] = useState(false);
  const [requirementError, setRequirementError] = useState<string | null>(null);
  const [requirementStreamEvents, setRequirementStreamEvents] = useState<
    StreamEvent[]
  >([]);
  const [clarificationAnswers, setClarificationAnswers] = useState<
    Record<string, DraftClarificationAnswer>
  >({});
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

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

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

  const loadProjectCanvas = useCallback(async (projectId: string) => {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/canvas`,
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(body?.message ?? "读取项目画布失败");
    }
    const data = (await response.json()) as ProjectCanvasData;
    setProjectCanvas(data);
    return data;
  }, []);

  const openProjectCanvas = useCallback(
    (project: Project) => {
      setCurrentCanvas("project");
      setSelectedProjectId(project.id);
      setProjectCanvas(null);
      setRequirementInput("");
      setRequirementError(null);
      setRequirementStreamEvents([]);
      setClarificationAnswers({});
      void loadProjectCanvas(project.id).catch((reason) =>
        setRequirementError(readError(reason)),
      );
    },
    [loadProjectCanvas],
  );

  const backToStartCanvas = useCallback(() => {
    setCurrentCanvas("start");
    setSelectedProjectId(null);
    setProjectCanvas(null);
    setRequirementInput("");
    setRequirementError(null);
    setRequirementStreamEvents([]);
    setClarificationAnswers({});
    void loadStart();
  }, [loadStart]);

  const activeRequirementId = projectCanvas?.active_requirement?.id ?? null;

  useEffect(() => {
    setRequirementStreamEvents([]);
    setClarificationAnswers({});
  }, [activeRequirementId]);

  useEffect(() => {
    if (!activeRequirementId || !selectedProjectId) {
      return;
    }

    const source = new EventSource(
      `/api/requirements/${encodeURIComponent(activeRequirementId)}/events`,
    );

    const handleEvent = (event: MessageEvent<string>) => {
      const parsed = parseStreamEvent(event.data);
      if (!parsed) {
        return;
      }
      setRequirementStreamEvents((current) => [...current, parsed]);

      const transient =
        parsed.event === "coordinator_started" ||
        parsed.event === "coordinator_progress" ||
        parsed.event === "pi_event";
      if (!transient) {
        void loadProjectCanvas(selectedProjectId).catch((reason) =>
          setRequirementError(readError(reason)),
        );
      }
    };

    source.onmessage = handleEvent;
    for (const eventName of [
      "coordinator_started",
      "coordinator_progress",
      "pi_event",
      "clarifications_ready",
      "draft_ready",
      "analysis_failed",
    ]) {
      source.addEventListener(eventName, handleEvent);
    }

    return () => source.close();
  }, [activeRequirementId, loadProjectCanvas, selectedProjectId]);

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

  const toggleModelSettings = useCallback(() => {
    setModelSettingsOpen((open) => {
      if (open) {
        return false;
      }

      void loadModelSettings();
      return true;
    });
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

  const sendRequirementMessage = useCallback(async () => {
    const message = requirementInput.trim();
    if (!message || !selectedProjectId) {
      return;
    }

    setRequirementBusy(true);
    setRequirementError(null);
    try {
      const active = projectCanvas?.active_requirement;
      const url = active
        ? `/api/requirements/${encodeURIComponent(active.id)}/messages`
        : `/api/projects/${encodeURIComponent(selectedProjectId)}/requirements`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? "提交需求失败");
      }
      setRequirementStreamEvents([]);
      setClarificationAnswers({});
      setProjectCanvas((await response.json()) as ProjectCanvasData);
      setRequirementInput("");
    } catch (reason) {
      setRequirementError(readError(reason));
    } finally {
      setRequirementBusy(false);
    }
  }, [projectCanvas, requirementInput, selectedProjectId]);

  const updateClarificationAnswer = useCallback(
    (
      clarification: RequirementClarification,
      answer: DraftClarificationAnswer,
    ) => {
      setClarificationAnswers((current) => ({
        ...current,
        [clarification.id]: answer,
      }));
    },
    [],
  );

  const submitClarifications = useCallback(
    async (requirement: Requirement) => {
      setRequirementBusy(true);
      setRequirementError(null);
      try {
        const answers = requirement.clarifications.map((clarification) =>
          buildClarificationAnswerPayload(
            clarification,
            clarificationAnswers[clarification.id] ??
              createDraftAnswer(clarification),
          ),
        );
        const response = await fetch(
          `/api/requirements/${encodeURIComponent(requirement.id)}/clarifications`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(answers),
          },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            message?: string;
          } | null;
          throw new Error(body?.message ?? "提交澄清答案失败");
        }
        setRequirementStreamEvents([]);
        setClarificationAnswers({});
        setProjectCanvas((await response.json()) as ProjectCanvasData);
      } catch (reason) {
        setRequirementError(readError(reason));
      } finally {
        setRequirementBusy(false);
      }
    },
    [clarificationAnswers],
  );

  const confirmRequirement = useCallback(async (requirement: Requirement) => {
    setRequirementBusy(true);
    setRequirementError(null);
    try {
      const response = await fetch(
        `/api/requirements/${encodeURIComponent(requirement.id)}/confirm`,
        {
          method: "POST",
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? "确认需求失败");
      }
      setProjectCanvas((await response.json()) as ProjectCanvasData);
    } catch (reason) {
      setRequirementError(readError(reason));
    } finally {
      setRequirementBusy(false);
    }
  }, []);

  const nodes = useMemo<Node<StartNodeData>[]>(() => {
    if (currentCanvas === "project") {
      const fallbackProject = selectedProjectId
        ? startData.projects.find((project) => project.id === selectedProjectId)
        : null;
      const project = projectCanvas?.project ?? fallbackProject;
      if (!project) {
        return [];
      }

      return [
        {
          id: "project-back",
          type: "startNode",
          position: { x: -260, y: 20 },
          data: {
            kind: "project-back",
            project,
            onBack: backToStartCanvas,
          },
        },
        {
          id: "completed-requirements",
          type: "startNode",
          position: { x: -260, y: 210 },
          data: {
            kind: "requirement-list",
            title: "已完成需求",
            description: `${projectCanvas?.completed_requirements.length ?? 0} 个`,
            requirements: projectCanvas?.completed_requirements ?? [],
            emptyText: "暂无已完成需求",
            tone: "done",
          },
        },
        {
          id: "requirement-chat",
          type: "startNode",
          position: { x: 130, y: 70 },
          data: {
            kind: "requirement-chat",
            project,
            requirement: projectCanvas?.active_requirement ?? null,
            input: requirementInput,
            busy: requirementBusy,
            error: requirementError,
            streamEvents: requirementStreamEvents,
            answers: clarificationAnswers,
            onInputChange: setRequirementInput,
            onSend: sendRequirementMessage,
            onAnswerChange: updateClarificationAnswer,
            onSubmitClarifications: submitClarifications,
            onConfirm: confirmRequirement,
          },
        },
        {
          id: "queued-requirements",
          type: "startNode",
          position: { x: 760, y: 210 },
          data: {
            kind: "requirement-list",
            title: "待执行 / 执行中",
            description: `${projectCanvas?.queued_requirements.length ?? 0} 个`,
            requirements: projectCanvas?.queued_requirements ?? [],
            emptyText: "确认需求后会进入这里",
            tone: "pending",
          },
        },
      ];
    }

    const projectListHeight = getProjectListHeight(startData.projects.length);

    const baseNodes: Node<StartNodeData>[] = [
      {
        id: "style-settings",
        type: "startNode",
        position: { x: 80, y: 80 },
        data: {
          kind: "style-settings",
          theme,
          onThemeChange: setTheme,
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
          onAction: toggleModelSettings,
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
          onOpenProject: openProjectCanvas,
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
    backToStartCanvas,
    cancelDeleteProject,
    confirmDeleteProject,
    confirmRequirement,
    createProject,
    creating,
    currentCanvas,
    deleteError,
    deletingId,
    clarificationAnswers,
    draftModelSettings,
    error,
    modelError,
    modelRpcStatus,
    modelSettingsOpen,
    models,
    pendingDeleteProject,
    projectCanvas,
    openProjectCanvas,
    requestDeleteProject,
    requirementBusy,
    requirementError,
    requirementInput,
    requirementStreamEvents,
    saveModelSettings,
    selectedProjectId,
    sendRequirementMessage,
    savingModels,
    setModelSettingsOpen,
    startData,
    theme,
    toggleModelSettings,
    submitClarifications,
    updateClarificationAnswer,
    updateModelTier,
  ]);

  const edges = useMemo<Edge[]>(() => {
    if (currentCanvas === "project") {
      return [];
    }

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
        targetHandle: "model-left",
        type: "smoothstep",
        animated: true,
        style: {
          stroke: "rgba(249, 115, 22, 0.68)",
          strokeWidth: 2,
        },
      });
    }

    return flowEdges;
  }, [currentCanvas, modelSettingsOpen, pendingDeleteProject]);

  return (
    <main className="app-shell" data-theme={theme}>
      <section className="toolbar">
        <div>
          <h1>Raccoon Node</h1>
          <p>
            {currentCanvas === "project" && projectCanvas
              ? `${projectCanvas.project.name} / 项目画布`
              : "Start 画布"}
          </p>
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

function parseStreamEvent(raw: string): StreamEvent | null {
  try {
    return JSON.parse(raw) as StreamEvent;
  } catch {
    return null;
  }
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

function requirementStatusText(status: RequirementStatus) {
  const labels: Record<RequirementStatus, string> = {
    analyzing: "分析中",
    clarifying: "澄清中",
    draft_ready: "待确认",
    queued: "等待执行",
    running: "执行中",
    completed: "已完成",
    failed: "分析失败",
  };
  return labels[status];
}

function requirementMessageRoleText(role: RequirementMessage["role"]) {
  if (role === "user") {
    return "你";
  }
  if (role === "assistant") {
    return "Coordinator";
  }
  if (role === "trace") {
    return "过程";
  }
  return "系统";
}

function traceStatusText(status: LiveBubble["status"]) {
  if (status === "running") return "进行中";
  if (status === "error") return "失败";
  return "完成";
}

function traceFromMessage(message: RequirementMessage): TraceData | null {
  if (message.role !== "trace" || message.metadata?.type !== "pi_trace") {
    return null;
  }
  return message.metadata.trace;
}

function buildBubbleStreamFromTrace(trace: TraceData): LiveBubble[] {
  const bubbles: LiveBubble[] = [];
  let seq = 0;

  for (const status of trace.statuses ?? []) {
    bubbles.push({
      id: `status-${seq++}`,
      type: "status",
      label: status.message,
      content: "",
      status: "done",
    });
  }

  if (trace.thinking?.trim()) {
    bubbles.push({
      id: `thinking-${seq++}`,
      type: "thinking",
      label: "思考过程",
      content: trace.thinking,
      status: "done",
    });
  }

  for (const tool of trace.tools ?? []) {
    bubbles.push({
      id: tool.toolCallId,
      type: "tool",
      label: tool.toolName,
      content: tool.output,
      toolName: tool.toolName,
      status: tool.isError || tool.status === "error" ? "error" : "done",
    });
  }

  // trace.output is intentionally not rendered: Pi Agent returns structured JSON
  // which is parsed into the assistant message and clarifications/draft. Showing
  // the raw JSON output would duplicate content and leak implementation details.
  return bubbles;
}

function buildBubbleStreamFromEvents(events: StreamEvent[]): LiveBubble[] {
  const bubbles: LiveBubble[] = [];
  let seq = 0;

  for (const event of events) {
    if (event.event !== "pi_event") continue;
    const payload = asRecord(event.payload);

    if (event.pi_type === "message_update") {
      const assistantEvent = asRecord(payload?.assistantMessageEvent);
      const deltaType = String(assistantEvent?.type ?? "");
      const delta = String(assistantEvent?.delta ?? assistantEvent?.text ?? "");
      if (!delta) continue;

      // Only stream thinking deltas; text deltas contain the structured JSON
      // response which is parsed into the assistant message after analysis ends.
      if (deltaType !== "thinking_delta") continue;

      const last = bubbles.at(-1);
      if (last?.type === "thinking") {
        last.content += delta;
      } else {
        bubbles.push({
          id: `thinking-${seq++}`,
          type: "thinking",
          label: "思考中...",
          content: delta,
          status: "running",
        });
      }
      continue;
    }

    if (event.pi_type === "tool_execution_start") {
      const toolCallId = String(
        payload?.toolCallId ?? payload?.tool_call_id ?? `tool-${seq++}`,
      );
      const toolName = String(
        payload?.toolName ?? payload?.tool_name ?? "tool",
      );
      bubbles.push({
        id: toolCallId,
        type: "tool",
        label: toolName,
        content: "",
        toolName,
        status: "running",
      });
      continue;
    }

    if (
      event.pi_type === "tool_execution_update" ||
      event.pi_type === "tool_execution_end"
    ) {
      const toolCallId = String(payload?.toolCallId ?? payload?.tool_call_id);
      const bubble = bubbles.find(
        (item) => item.id === toolCallId && item.type === "tool",
      );
      if (!bubble) continue;
      const output = extractToolOutput(payload);
      if (output) bubble.content = output;
      if (event.pi_type === "tool_execution_end") {
        bubble.status =
          payload?.isError || payload?.is_error ? "error" : "done";
      }
      continue;
    }

    if (event.pi_type === "agent_end") {
      for (const bubble of bubbles) {
        if (bubble.status === "running") bubble.status = "done";
      }
      bubbles.push({
        id: `end-${seq++}`,
        type: "status",
        label: "分析完成",
        content: "",
        status: "done",
      });
    }
  }

  return bubbles;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function extractToolOutput(payload: Record<string, unknown> | null) {
  const result = asRecord(
    payload?.partialResult ?? payload?.partial_result ?? payload?.result,
  );
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map((item) => asRecord(item)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function createDraftAnswer(
  clarification: RequirementClarification,
): DraftClarificationAnswer {
  return {
    selectedOptions: clarification.answer?.selected_options ?? [],
    customText: clarification.answer?.custom_text ?? "",
  };
}

function hasDraftAnswer(
  clarification: RequirementClarification,
  answer?: DraftClarificationAnswer,
) {
  if (!answer) return false;
  if (clarification.question_type === "free_text") {
    return answer.customText.trim().length > 0;
  }
  return (
    answer.selectedOptions.length > 0 || answer.customText.trim().length > 0
  );
}

function toggleClarificationOption(
  clarification: RequirementClarification,
  answer: DraftClarificationAnswer,
  value: string,
): DraftClarificationAnswer {
  if (clarification.question_type === "single_choice") {
    return { ...answer, selectedOptions: [value] };
  }

  const selectedOptions = answer.selectedOptions.includes(value)
    ? answer.selectedOptions.filter((item) => item !== value)
    : [...answer.selectedOptions, value];
  return { ...answer, selectedOptions };
}

function buildClarificationAnswerPayload(
  clarification: RequirementClarification,
  answer: DraftClarificationAnswer,
) {
  return {
    clarification_id: clarification.id,
    selected_options:
      clarification.question_type === "free_text" ? [] : answer.selectedOptions,
    custom_text: answer.customText.trim() || null,
  };
}

function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "light"
    ? "light"
    : "dark";
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
