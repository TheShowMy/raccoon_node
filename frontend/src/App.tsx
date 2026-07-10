import {
  Background,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  ReactFlow,
} from "@xyflow/react";
import {
  Button,
  ChatComposer,
  ChatComposerDrawer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  ChatToolCalls,
  Markdown,
  ProgressBar,
  StatusDot,
  Text,
  TextArea,
  TextInput,
  Token,
} from "@astryxdesign/core";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  ClipboardList,
  Check,
  Code2,
  Eye,
  FileText,
  Files,
  Folder,
  Gauge,
  GitBranch,
  GitCommit,
  GitPullRequest,
  KeyRound,
  Paperclip,
  MessageSquare,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BasicSettings,
  FileReference,
  GitAction,
  GitDiff,
  GitStatus,
  ImageAttachment,
  ModelSettings,
  ModelSettingsResponse,
  ModelTierSetting,
  ProjectCanvasData,
  ProjectChatResponse,
  ProjectTokenUsage,
  Requirement,
  RequirementExecutionTask,
  RequirementStatus,
  TerminalAccessStatus,
  TerminalSession,
  ThemeMode,
  ThemePack,
} from "./types/api";

const PROJECT_ID = "current";
const CHAT_SIZE = { width: 960, height: 760 };
const ORBIT_NODE_SIZE = { width: 184, height: 116 };
const CENTER = { x: 0, y: 0 };
const ELLIPSE = { rx: 860, ry: 620 };
const PANEL_GAP = 310;
const PARALLAX_MAX = 260;

type FileEntry = {
  path: string;
};

type PanelKind =
  | "settings"
  | "terminal"
  | "git"
  | "tokens"
  | "requirements"
  | "files";

type OrbitNodeKind = PanelKind | "chat";

type OrbitNodeData = {
  kind: OrbitNodeKind;
  title: string;
  detail: string;
  icon: ReactNode;
  status?: "success" | "warning" | "error" | "accent" | "neutral";
  isActive?: boolean;
  onOpen?: () => void;
};

type PanelNodeData = {
  kind: PanelKind;
  title: string;
  onClose: () => void;
};

type LoadedState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  low: { model_id: null, thinking_level: "low" },
  medium: { model_id: null, thinking_level: "medium" },
  high: { model_id: null, thinking_level: "high" },
};

function makeLoaded<T>(data: T | null = null): LoadedState<T> {
  return { data, error: null, loading: false };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string };
      message = body.message ?? message;
    } catch {
      // Keep the HTTP status as the fallback.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

async function uploadProjectAttachment(file: File): Promise<ImageAttachment> {
  return api<ImageAttachment>(`/projects/${PROJECT_ID}/attachments`, {
    method: "POST",
    body: JSON.stringify({
      name: file.name || "image",
      mime_type: file.type,
      data_base64: await readFileAsDataUrl(file),
    }),
  });
}

function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api${path}`;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function formatNumber(value: number | undefined): string {
  return new Intl.NumberFormat().format(value ?? 0);
}

function formatPercent(value: number | undefined): string {
  return `${Math.round(value ?? 0)}%`;
}

function requirementProgress(requirement: Requirement): string {
  const tasks = requirement.execution_plan?.tasks ?? [];
  if (!tasks.length) return "0/0";
  const done = tasks.filter((task) =>
    ["approved", "completed", "skipped"].includes(task.status),
  ).length;
  return `${done}/${tasks.length}`;
}

function dedupeRequirements(requirements: Requirement[]): Requirement[] {
  return requirements.filter(
    (item, index) =>
      requirements.findIndex((candidate) => candidate.id === item.id) === index,
  );
}

function iconForRequirement(status: RequirementStatus): ReactNode {
  const className = cx("node-icon", `status-${status}`);
  return <ClipboardList className={className} size={24} />;
}

function statusVariant(status?: RequirementStatus): OrbitNodeData["status"] {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (
    status === "running" ||
    status === "planning" ||
    status === "plan_ready" ||
    status === "analyzing"
  ) {
    return "accent";
  }
  if (
    status === "clarifying" ||
    status === "draft_ready" ||
    status === "queued"
  ) {
    return "warning";
  }
  return "neutral";
}

function useWindowSize() {
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () =>
      setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return size;
}

function viewportFor(
  size: { width: number; height: number },
  target: { x: number; y: number },
  zoom: number,
) {
  return {
    x: size.width / 2 - target.x * zoom,
    y: size.height / 2 - target.y * zoom,
    zoom,
  };
}

function useAppData() {
  const [canvas, setCanvas] =
    useState<LoadedState<ProjectCanvasData>>(makeLoaded());
  const [chat, setChat] =
    useState<LoadedState<ProjectChatResponse>>(makeLoaded());
  const [settings, setSettings] =
    useState<LoadedState<BasicSettings>>(makeLoaded());
  const [models, setModels] =
    useState<LoadedState<ModelSettingsResponse>>(makeLoaded());
  const [git, setGit] = useState<LoadedState<GitStatus>>(makeLoaded());
  const [terminals, setTerminals] = useState<LoadedState<TerminalSession[]>>(
    makeLoaded([]),
  );
  const [terminalAccess, setTerminalAccess] =
    useState<LoadedState<TerminalAccessStatus>>(makeLoaded());
  const [eventLine, setEventLine] = useState("Ready.");

  const loadCanvas = useCallback(async () => {
    setCanvas((state) => ({ ...state, loading: true }));
    try {
      const data = await api<ProjectCanvasData>(
        `/projects/${PROJECT_ID}/canvas`,
      );
      setCanvas({ data, error: null, loading: false });
    } catch (error) {
      setCanvas((state) => ({
        ...state,
        error: String(error),
        loading: false,
      }));
    }
  }, []);

  const loadChat = useCallback(async () => {
    setChat((state) => ({ ...state, loading: true }));
    try {
      const data = await api<ProjectChatResponse>(
        `/projects/${PROJECT_ID}/chat`,
      );
      setChat({ data, error: null, loading: false });
    } catch (error) {
      setChat((state) => ({ ...state, error: String(error), loading: false }));
    }
  }, []);

  const loadSettings = useCallback(async () => {
    setSettings((state) => ({ ...state, loading: true }));
    try {
      const data = await api<BasicSettings>("/settings/basic");
      setSettings({ data, error: null, loading: false });
      document.documentElement.dataset.themeMode = data.theme_mode;
      document.documentElement.dataset.themePack = data.theme_pack;
    } catch (error) {
      setSettings((state) => ({
        ...state,
        error: String(error),
        loading: false,
      }));
    }
  }, []);

  const loadModels = useCallback(async () => {
    setModels((state) => ({ ...state, loading: true }));
    try {
      const data = await api<ModelSettingsResponse>("/settings/models");
      setModels({ data, error: null, loading: false });
    } catch (error) {
      setModels((state) => ({
        ...state,
        error: String(error),
        loading: false,
      }));
    }
  }, []);

  const loadGit = useCallback(async () => {
    setGit((state) => ({ ...state, loading: true }));
    try {
      const data = await api<GitStatus>(`/projects/${PROJECT_ID}/git/status`);
      setGit({ data, error: null, loading: false });
    } catch (error) {
      setGit((state) => ({ ...state, error: String(error), loading: false }));
    }
  }, []);

  const loadTerminals = useCallback(async () => {
    setTerminals((state) => ({ ...state, loading: true }));
    try {
      const data = await api<TerminalSession[]>(
        `/projects/${PROJECT_ID}/terminals`,
      );
      setTerminals({ data, error: null, loading: false });
    } catch (error) {
      setTerminals((state) => ({
        ...state,
        error: String(error),
        loading: false,
      }));
    }
  }, []);

  const loadTerminalAccess = useCallback(async () => {
    setTerminalAccess((state) => ({ ...state, loading: true }));
    try {
      const data = await api<TerminalAccessStatus>(
        `/projects/${PROJECT_ID}/terminal-access`,
      );
      setTerminalAccess({ data, error: null, loading: false });
    } catch (error) {
      setTerminalAccess((state) => ({
        ...state,
        error: String(error),
        loading: false,
      }));
    }
  }, []);

  const refreshAll = useCallback(() => {
    void loadCanvas();
    void loadChat();
    void loadSettings();
    void loadModels();
    void loadGit();
    void loadTerminals();
    void loadTerminalAccess();
  }, [
    loadCanvas,
    loadChat,
    loadGit,
    loadModels,
    loadSettings,
    loadTerminalAccess,
    loadTerminals,
  ]);

  useEffect(() => {
    refreshAll();
    const interval = window.setInterval(() => {
      void loadCanvas();
      void loadGit();
    }, 8000);
    return () => window.clearInterval(interval);
  }, [loadCanvas, loadGit, refreshAll]);

  useEffect(() => {
    const socket = new WebSocket(wsUrl(`/projects/${PROJECT_ID}/chat/events`));
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type?: string;
          payload?: { message?: string };
        };
        setEventLine(
          data.payload?.message ?? data.type ?? "Chat event received.",
        );
      } catch {
        setEventLine("Chat event received.");
      }
      void loadChat();
      void loadCanvas();
    };
    socket.onerror = () => setEventLine("Chat event stream is not connected.");
    return () => socket.close();
  }, [loadCanvas, loadChat]);

  return {
    canvas,
    chat,
    settings,
    models,
    git,
    terminals,
    terminalAccess,
    eventLine,
    loadCanvas,
    loadChat,
    loadSettings,
    loadModels,
    loadGit,
    loadTerminals,
    loadTerminalAccess,
    refreshAll,
  };
}

export function App() {
  const data = useAppData();
  const size = useWindowSize();
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const parallaxTargetRef = useRef(CENTER);
  const parallaxCurrentRef = useRef(CENTER);
  const parallaxFrameRef = useRef<number | null>(null);
  const parallaxFrozenRef = useRef(false);
  const parallaxReleaseRef = useRef<number | null>(null);
  const [openPanel, setOpenPanel] = useState<{
    kind: PanelKind;
  } | null>(null);
  const openPanelFor = useCallback((item: OrbitNodeData) => {
    if (item.kind === "chat") return;
    setOpenPanel({
      kind: item.kind as PanelKind,
    });
  }, []);

  const zoom = useMemo(() => {
    const safeWidth = Math.max(320, size.width - 80);
    const safeHeight = Math.max(320, size.height - 80);
    const contentWidth = Math.max(
      CHAT_SIZE.width,
      ELLIPSE.rx * 2 + ORBIT_NODE_SIZE.width,
    );
    const contentHeight = Math.max(
      CHAT_SIZE.height,
      ELLIPSE.ry * 2 + ORBIT_NODE_SIZE.height,
    );
    return Math.min(1, safeWidth / contentWidth, safeHeight / contentHeight);
  }, [size.height, size.width]);

  const requirements = useMemo(() => {
    const canvas = data.canvas.data;
    const all = [
      ...(canvas?.active_requirement ? [canvas.active_requirement] : []),
      ...(canvas?.queued_requirements ?? []),
      ...(canvas?.completed_requirements ?? []),
    ];
    return all
      .filter(
        (item, index) =>
          all.findIndex((candidate) => candidate.id === item.id) === index,
      )
      .sort((a, b) => {
        const rank: Record<RequirementStatus, number> = {
          planning: 1,
          plan_ready: 2,
          running: 3,
          analyzing: 4,
          clarifying: 5,
          draft_ready: 6,
          queued: 7,
          failed: 8,
          completed: 9,
        };
        return (
          (rank[a.status] ?? 20) - (rank[b.status] ?? 20) ||
          a.created_at.localeCompare(b.created_at)
        );
      });
  }, [data.canvas.data]);

  const orbitItems = useMemo<OrbitNodeData[]>(() => {
    const gitFiles = data.git.data?.files.length ?? 0;
    const tokenPercent = data.canvas.data?.token_usage?.context_percent ?? 0;
    const terminalCount = data.terminals.data?.length ?? 0;
    const base: OrbitNodeData[] = [
      {
        kind: "settings",
        title: "设置",
        detail: data.settings.data
          ? `${data.settings.data.theme_pack} / ${data.settings.data.theme_mode}`
          : "运行与模型",
        icon: <Settings size={24} />,
        status: data.models.data?.rpc_status === "error" ? "error" : "neutral",
      },
      {
        kind: "terminal",
        title: "终端",
        detail: `${terminalCount} 个会话`,
        icon: <TerminalSquare size={24} />,
        status:
          data.terminalAccess.data?.required &&
          !data.terminalAccess.data.authorized
            ? "warning"
            : "neutral",
      },
      {
        kind: "git",
        title: "Git",
        detail: data.git.data?.branch ?? "状态",
        icon: <GitBranch size={24} />,
        status: data.git.data?.write_blocked
          ? "warning"
          : gitFiles > 0
            ? "accent"
            : "success",
      },
      {
        kind: "tokens",
        title: "Token",
        detail: formatPercent(tokenPercent),
        icon: <Gauge size={24} />,
        status:
          tokenPercent > 85
            ? "error"
            : tokenPercent > 65
              ? "warning"
              : "neutral",
      },
      {
        kind: "requirements",
        title: "需求列表",
        detail: `${requirements.length} 个需求`,
        icon: <ClipboardList size={24} />,
        status: requirements.some((item) => item.status === "failed")
          ? "error"
          : "neutral",
      },
      {
        kind: "files",
        title: "文件",
        detail: data.canvas.data?.project.name ?? "仓库文件",
        icon: <Files size={24} />,
        status: "neutral",
      },
    ];

    return base;
  }, [
    data.canvas.data,
    data.git.data,
    data.models.data,
    data.settings.data,
    data.terminalAccess.data,
    data.terminals.data,
    requirements,
  ]);

  const panelSize = openPanel ? sizeForPanel(openPanel.kind) : null;
  const nodes = useMemo<Node[]>(() => {
    const result: Node[] = [
      {
        id: "chat",
        type: "chat",
        position: {
          x: CENTER.x - CHAT_SIZE.width / 2,
          y: CENTER.y - CHAT_SIZE.height / 2,
        },
        data: {
          kind: "chat",
          title: "项目对话",
          detail: data.canvas.data?.project.local_path ?? "current",
          icon: <MessageSquare size={24} />,
        },
        draggable: false,
      },
    ];

    orbitItems.forEach((item, index) => {
      const point = pointOnEllipse(index, orbitItems.length);
      const panelMatches = openPanel?.kind === item.kind;
      result.push({
        id: orbitId(item, index),
        type: "orbit",
        position: {
          x: point.x - ORBIT_NODE_SIZE.width / 2,
          y: point.y - ORBIT_NODE_SIZE.height / 2,
        },
        data: {
          ...item,
          isActive: panelMatches,
          onOpen: () => openPanelFor(item),
        },
        draggable: false,
      });
    });

    if (openPanel && panelSize) {
      const panelIndex = orbitItems.findIndex((item) => {
        return item.kind === openPanel.kind;
      });
      const anchor = pointOnEllipse(
        Math.max(0, panelIndex),
        orbitItems.length || 1,
      );
      const length = Math.hypot(anchor.x, anchor.y) || 1;
      const unit = { x: anchor.x / length, y: anchor.y / length };
      const panelCenter = {
        x: anchor.x + unit.x * (PANEL_GAP + panelSize.width / 2),
        y: anchor.y + unit.y * (PANEL_GAP + panelSize.height / 2),
      };
      result.push({
        id: "panel",
        type: "panel",
        position: {
          x: panelCenter.x - panelSize.width / 2,
          y: panelCenter.y - panelSize.height / 2,
        },
        data: {
          ...openPanel,
          title: panelTitle(openPanel),
          onClose: () => setOpenPanel(null),
        },
        draggable: false,
        style: {
          width: panelSize.width,
          height: panelSize.height,
        },
      });
    }

    return result;
  }, [
    data.canvas.data?.project.local_path,
    openPanel,
    openPanelFor,
    orbitItems,
    panelSize,
  ]);

  const cancelParallax = useCallback(() => {
    if (parallaxFrameRef.current !== null) {
      window.cancelAnimationFrame(parallaxFrameRef.current);
      parallaxFrameRef.current = null;
    }
  }, []);

  const startParallax = useCallback(() => {
    if (parallaxFrameRef.current !== null) return;

    const tick = () => {
      parallaxFrameRef.current = null;
      if (openPanel || parallaxFrozenRef.current || !flowRef.current) return;

      const current = parallaxCurrentRef.current;
      const target = parallaxTargetRef.current;
      const next = {
        x: current.x + (target.x - current.x) * 0.16,
        y: current.y + (target.y - current.y) * 0.16,
      };
      parallaxCurrentRef.current = next;
      flowRef.current.setViewport(viewportFor(size, next, zoom), {
        duration: 0,
      });

      if (Math.hypot(target.x - next.x, target.y - next.y) > 0.5) {
        parallaxFrameRef.current = window.requestAnimationFrame(tick);
      }
    };

    parallaxFrameRef.current = window.requestAnimationFrame(tick);
  }, [openPanel, size, zoom]);

  const centerTarget = useCallback(
    (target: { x: number; y: number }, animated = true) => {
      cancelParallax();
      parallaxTargetRef.current = target;
      parallaxCurrentRef.current = target;
      flowRef.current?.setViewport(viewportFor(size, target, zoom), {
        duration: animated ? 460 : 0,
      });
    },
    [cancelParallax, size, zoom],
  );

  useEffect(() => {
    if (!flowRef.current) return;
    if (!openPanel) {
      centerTarget(CENTER, true);
      return;
    }
    const panel = nodes.find((node) => node.id === "panel");
    const width = Number(panel?.style?.width ?? panelSize?.width ?? 720);
    const height = Number(panel?.style?.height ?? panelSize?.height ?? 520);
    centerTarget(
      {
        x: (panel?.position.x ?? 0) + width / 2,
        y: (panel?.position.y ?? 0) + height / 2,
      },
      true,
    );
  }, [centerTarget, nodes, openPanel, panelSize]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (openPanel || parallaxFrozenRef.current || !flowRef.current) return;
      const nx = (event.clientX - size.width / 2) / Math.max(1, size.width / 2);
      const ny =
        (event.clientY - size.height / 2) / Math.max(1, size.height / 2);
      parallaxTargetRef.current = {
        x: Math.max(-1, Math.min(1, nx)) * PARALLAX_MAX,
        y: Math.max(-1, Math.min(1, ny)) * PARALLAX_MAX,
      };
      startParallax();
    },
    [openPanel, size.height, size.width, startParallax],
  );

  const releaseParallaxSoon = useCallback(() => {
    if (parallaxReleaseRef.current !== null) {
      window.clearTimeout(parallaxReleaseRef.current);
    }
    parallaxReleaseRef.current = window.setTimeout(() => {
      parallaxFrozenRef.current = false;
      parallaxReleaseRef.current = null;
      startParallax();
    }, 120);
  }, [startParallax]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if ((event.target as Element | null)?.closest(".react-flow__node")) {
        parallaxFrozenRef.current = true;
        parallaxTargetRef.current = parallaxCurrentRef.current;
        cancelParallax();
      }
    },
    [cancelParallax],
  );

  useEffect(() => {
    return () => {
      cancelParallax();
      if (parallaxReleaseRef.current !== null) {
        window.clearTimeout(parallaxReleaseRef.current);
      }
    };
  }, [cancelParallax]);

  const nodeTypes = useMemo(
    () => ({
      chat: (props: NodeProps) => <ChatNode {...props} appData={data} />,
      orbit: OrbitNode,
      panel: (props: NodeProps) => <PanelNode {...props} appData={data} />,
    }),
    [data],
  );

  return (
    <main
      className="app-root"
      onPointerCancel={releaseParallaxSoon}
      onPointerDownCapture={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUpCapture={releaseParallaxSoon}
    >
      <div className="canvas-hud" aria-live="polite">
        <Text type="supporting" display="block" maxLines={1}>
          {data.eventLine}
        </Text>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={[] as Edge[]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          flowRef.current = instance;
          instance.setViewport(viewportFor(size, CENTER, zoom), {
            duration: 0,
          });
        }}
        onNodeClick={(_, node) => {
          if (node.type !== "orbit") return;
          openPanelFor(node.data as OrbitNodeData);
        }}
      >
        <Background gap={44} size={1} color="var(--color-border)" />
      </ReactFlow>
    </main>
  );
}

function pointOnEllipse(index: number, total: number) {
  const angle = -Math.PI / 2 + (index / Math.max(total, 1)) * Math.PI * 2;
  return {
    x: Math.cos(angle) * ELLIPSE.rx,
    y: Math.sin(angle) * ELLIPSE.ry,
  };
}

function orbitId(item: OrbitNodeData, index: number): string {
  return `${item.kind}-${index}`;
}

function sizeForPanel(kind: PanelKind) {
  switch (kind) {
    case "settings":
      return { width: 780, height: 640 };
    case "terminal":
      return { width: 920, height: 620 };
    case "git":
      return { width: 760, height: 580 };
    case "tokens":
      return { width: 520, height: 420 };
    case "requirements":
      return { width: 1040, height: 660 };
    case "files":
      return { width: 880, height: 620 };
  }
}

function panelTitle(panel: { kind: PanelKind }) {
  const titles: Record<PanelKind, string> = {
    settings: "设置",
    terminal: "终端",
    git: "Git",
    tokens: "Token",
    requirements: "需求列表",
    files: "文件",
  };
  return titles[panel.kind];
}

function ChatNode({
  appData,
}: NodeProps & {
  appData: ReturnType<typeof useAppData>;
}) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<"chat" | "requirement">("chat");
  const [submitting, setSubmitting] = useState(false);
  const [references, setReferences] = useState<FileReference[]>([]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [fileQuery, setFileQuery] = useState("");
  const [fileResults, setFileResults] = useState<FileReference[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [clarificationText, setClarificationText] = useState<
    Record<string, string>
  >({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chat = appData.chat.data;
  const activeRequirement = appData.canvas.data?.active_requirement ?? null;
  const showCommands = value.trim() === "/";
  const commandMenu = [
    {
      label: "需求生成",
      detail: "从当前输入进入澄清和确认流程",
      action: () => {
        setMode("requirement");
        setValue("");
      },
    },
    {
      label: "新建会话",
      detail: "重置当前普通聊天上下文",
      action: () => void resetChat(),
    },
  ];

  const send = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || chat?.running || submitting) return;
    if (trimmed === "/需求生成") {
      setMode("requirement");
      setValue("");
      return;
    }
    if (trimmed === "/新建会话") {
      await resetChat();
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "requirement") {
        await api<{ accepted: boolean }>(
          `/projects/${PROJECT_ID}/requirements`,
          {
            method: "POST",
            body: JSON.stringify({
              message: trimmed,
              references,
              images,
            }),
          },
        );
        await appData.loadCanvas();
      } else {
        await api<{ accepted: boolean }>(
          `/projects/${PROJECT_ID}/chat/messages`,
          {
            method: "POST",
            body: JSON.stringify({
              message: trimmed,
              references,
              images,
            }),
          },
        );
        await appData.loadChat();
      }
      setValue("");
      setReferences([]);
      setImages([]);
    } finally {
      setSubmitting(false);
    }
  };

  const abort = async () => {
    await api<{ accepted: boolean }>(`/projects/${PROJECT_ID}/chat/abort`, {
      method: "POST",
    });
    await appData.loadChat();
  };

  const resetChat = async () => {
    if (chat?.running || submitting) return;
    const response = await fetch(`/api/projects/${PROJECT_ID}/chat`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    setMode("chat");
    setValue("");
    setReferences([]);
    setImages([]);
    await appData.loadChat();
  };

  const searchFiles = async () => {
    const query = fileQuery.trim();
    if (!query) return;
    const body = await api<unknown>(
      `/projects/${PROJECT_ID}/files?search=${encodeURIComponent(query)}`,
    );
    const raw = Array.isArray(body)
      ? body
      : Array.isArray((body as { files?: unknown[] }).files)
        ? (body as { files: unknown[] }).files
        : [];
    setFileResults(
      raw.map((item) =>
        typeof item === "string"
          ? { path: item }
          : { path: String((item as { path?: string }).path ?? "") },
      ),
    );
  };

  const uploadImages = async (files: FileList | File[]) => {
    setAttachmentError("");
    const imageFiles = Array.from(files).filter((file) =>
      file.type.startsWith("image/"),
    );
    try {
      const uploaded = await Promise.all(
        imageFiles.map(uploadProjectAttachment),
      );
      setImages((current) => [...current, ...uploaded]);
    } catch (error) {
      setAttachmentError(String(error));
    }
  };

  const confirmRequirement = async (requirement: Requirement) => {
    await api<unknown>(`/requirements/${requirement.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await appData.loadCanvas();
  };

  const submitClarifications = async (requirement: Requirement) => {
    const answers = (requirement.clarifications ?? []).map((item) => ({
      clarification_id: item.id,
      selected_options: [],
      custom_text: clarificationText[item.id] ?? "",
    }));
    await api<unknown>(`/requirements/${requirement.id}/clarifications`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    });
    await appData.loadCanvas();
  };

  const activeQuestions = (activeRequirement?.clarifications ?? []).filter(
    (item) => !item.answer,
  );

  return (
    <section
      className="chat-node nodrag nopan"
      style={{ width: CHAT_SIZE.width, height: CHAT_SIZE.height }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void uploadImages(event.dataTransfer.files);
      }}
      onPaste={(event) => {
        const files = event.clipboardData.files;
        if (files.length) void uploadImages(files);
      }}
    >
      <header className="chat-node-header">
        <div>
          <Text type="large" weight="semibold" display="block">
            {mode === "requirement" ? "需求生成" : "项目对话"}
          </Text>
          <Text
            type="supporting"
            color="secondary"
            display="block"
            maxLines={1}
          >
            {appData.canvas.data?.project.local_path ?? "current"}
          </Text>
        </div>
        <div className="node-actions">
          <Token
            label={mode === "requirement" ? "需求生成" : "普通聊天"}
            color={mode === "requirement" ? "orange" : "blue"}
            size="sm"
          />
          <Token
            label={chat?.running ? "生成中" : "就绪"}
            color={chat?.running ? "blue" : "green"}
            size="sm"
          />
          <Button
            label="新建会话"
            variant="ghost"
            size="sm"
            icon={<RotateCcw size={16} />}
            onClick={() => void resetChat()}
            isDisabled={!chat || chat.running}
          />
        </div>
      </header>

      <ChatLayout
        density="spacious"
        composer={
          <ChatComposer
            value={value}
            onChange={setValue}
            onSubmit={(next) => void send(next)}
            onStop={() => void abort()}
            isStopShown={Boolean(chat?.running)}
            isDisabled={submitting}
            placeholder={
              mode === "requirement"
                ? "描述需求，或继续补充上下文..."
                : "询问项目，或输入 /"
            }
            drawer={
              <ChatComposerDrawer
                count={
                  references.length +
                  images.length +
                  (activeRequirement ? 1 : 0) +
                  (showCommands ? commandMenu.length : 0)
                }
                label="上下文"
              >
                {showCommands ? (
                  <div className="command-menu">
                    {commandMenu.map((command) => (
                      <button
                        className="command-menu-item"
                        key={command.label}
                        type="button"
                        onClick={command.action}
                      >
                        <Text type="label" display="block">
                          /{command.label}
                        </Text>
                        <Text type="supporting" color="secondary" maxLines={1}>
                          {command.detail}
                        </Text>
                      </button>
                    ))}
                  </div>
                ) : null}
                {activeQuestions.length ? (
                  <section className="floating-card">
                    <Text type="large" weight="semibold" display="block">
                      澄清问题
                    </Text>
                    {activeQuestions.map((question) => (
                      <label className="field-row" key={question.id}>
                        <Text type="label">{question.question}</Text>
                        <TextArea
                          label="回答"
                          rows={2}
                          value={clarificationText[question.id] ?? ""}
                          onChange={(next) =>
                            setClarificationText((current) => ({
                              ...current,
                              [question.id]: next,
                            }))
                          }
                        />
                      </label>
                    ))}
                    <Button
                      label="提交澄清"
                      variant="primary"
                      onClick={() =>
                        activeRequirement
                          ? void submitClarifications(activeRequirement)
                          : undefined
                      }
                    />
                  </section>
                ) : null}
                {activeRequirement?.draft ? (
                  <section className="floating-card">
                    <Text type="large" weight="semibold" display="block">
                      {activeRequirement.draft.title}
                    </Text>
                    <Markdown density="compact">
                      {activeRequirement.draft.summary}
                    </Markdown>
                    <div className="chip-row">
                      {activeRequirement.draft.acceptance_criteria.map(
                        (item) => (
                          <Token key={item} label={item} color="blue" />
                        ),
                      )}
                    </div>
                    <div className="inline-actions">
                      <Button
                        label="确认并执行"
                        variant="primary"
                        icon={<Check size={16} />}
                        onClick={() =>
                          void confirmRequirement(activeRequirement)
                        }
                      />
                      <Button
                        label="继续补充"
                        variant="ghost"
                        onClick={() => {
                          setMode("requirement");
                          setValue(activeRequirement.original_message ?? "");
                        }}
                      />
                    </div>
                  </section>
                ) : null}
                <div className="attachment-drawer">
                  <form
                    className="search-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void searchFiles();
                    }}
                  >
                    <TextInput
                      label="@file"
                      value={fileQuery}
                      onChange={setFileQuery}
                    />
                    <Button
                      label="搜索"
                      type="submit"
                      icon={<Search size={16} />}
                    />
                  </form>
                  <div className="chip-row">
                    {fileResults.slice(0, 5).map((file) => (
                      <button
                        className="chip-button"
                        key={file.path}
                        type="button"
                        onClick={() =>
                          setReferences((current) =>
                            current.some((item) => item.path === file.path)
                              ? current
                              : [...current, file],
                          )
                        }
                      >
                        @{file.path}
                      </button>
                    ))}
                  </div>
                  <div className="chip-row">
                    {references.map((reference) => (
                      <Token
                        key={reference.path}
                        label={`@${reference.path}`}
                        color="blue"
                        size="sm"
                      />
                    ))}
                    {images.map((image) => (
                      <Token
                        key={image.path}
                        label={image.name}
                        color="green"
                        size="sm"
                      />
                    ))}
                  </div>
                  {attachmentError ? (
                    <Text color="accent">{attachmentError}</Text>
                  ) : null}
                </div>
              </ChatComposerDrawer>
            }
            headerActions={
              <>
                <input
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="visually-hidden"
                  multiple
                  ref={fileInputRef}
                  type="file"
                  onChange={(event) => {
                    if (event.currentTarget.files) {
                      void uploadImages(event.currentTarget.files);
                    }
                    event.currentTarget.value = "";
                  }}
                />
                <Button
                  label="上传图片"
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<Paperclip size={16} />}
                  onClick={() => fileInputRef.current?.click()}
                />
              </>
            }
            sendActions={<Send size={18} aria-hidden />}
          />
        }
      >
        <ChatMessageList>
          <ChatSystemMessage variant="divider">current</ChatSystemMessage>
          {appData.chat.loading ? (
            <ChatSystemMessage>加载对话中...</ChatSystemMessage>
          ) : null}
          {appData.chat.error ? (
            <ChatSystemMessage>{appData.chat.error}</ChatSystemMessage>
          ) : null}
          {chat?.messages.length ? (
            chat.messages.map((message, index) => (
              <ChatMessage
                key={`${message.created_at}-${index}`}
                sender={message.role === "user" ? "user" : "assistant"}
              >
                <ChatMessageBubble
                  variant={message.role === "system" ? "ghost" : "filled"}
                >
                  <Markdown density="compact">{message.content}</Markdown>
                </ChatMessageBubble>
              </ChatMessage>
            ))
          ) : (
            <ChatMessage sender="assistant">
              <ChatMessageBubble>
                <Markdown density="compact">
                  {
                    "这里是当前 Git 仓库的项目对话。可以直接提问，也可以沉淀为需求继续推进。"
                  }
                </Markdown>
              </ChatMessageBubble>
            </ChatMessage>
          )}
          {chat?.running ? (
            <ChatMessage sender="assistant">
              <ChatMessageBubble variant="ghost">
                <ChatToolCalls
                  calls={[
                    { name: "Pi Agent", status: "running", target: "项目问答" },
                  ]}
                />
              </ChatMessageBubble>
            </ChatMessage>
          ) : null}
        </ChatMessageList>
      </ChatLayout>
    </section>
  );
}

function OrbitNode(props: NodeProps) {
  const data = props.data as OrbitNodeData;
  return (
    <button
      className={cx(
        "orbit-node nodrag nopan",
        data.isActive && "is-active",
        data.status && `is-${data.status}`,
      )}
      style={{ width: ORBIT_NODE_SIZE.width, height: ORBIT_NODE_SIZE.height }}
      onClick={data.onOpen}
      type="button"
    >
      <span className="orbit-node-icon">{data.icon}</span>
      <span className="orbit-node-copy">
        <Text type="label" display="block" maxLines={1}>
          {data.title}
        </Text>
        <Text type="supporting" color="secondary" display="block" maxLines={1}>
          {data.detail}
        </Text>
      </span>
      <StatusDot
        variant={data.status ?? "neutral"}
        label={data.status ?? "neutral"}
        isPulsing={data.status === "accent"}
      />
    </button>
  );
}

function PanelNode({
  data,
  appData,
}: NodeProps & {
  appData: ReturnType<typeof useAppData>;
}) {
  const panel = data as PanelNodeData;
  return (
    <section className="panel-node nodrag nopan">
      <header className="panel-header">
        <Text type="large" weight="semibold" display="block" maxLines={1}>
          {panel.title}
        </Text>
        <Button
          label="关闭"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<X size={18} />}
          onClick={panel.onClose}
        />
      </header>
      <div className="panel-body">
        {panel.kind === "settings" ? <SettingsPanel appData={appData} /> : null}
        {panel.kind === "terminal" ? <TerminalPanel appData={appData} /> : null}
        {panel.kind === "git" ? <GitPanel appData={appData} /> : null}
        {panel.kind === "tokens" ? (
          <TokenPanel usage={appData.canvas.data?.token_usage ?? null} />
        ) : null}
        {panel.kind === "requirements" ? (
          <RequirementsPanel appData={appData} />
        ) : null}
        {panel.kind === "files" ? <FilesPanel /> : null}
      </div>
    </section>
  );
}

function SettingsPanel({
  appData,
}: {
  appData: ReturnType<typeof useAppData>;
}) {
  const settings = appData.settings.data;
  const models = appData.models.data;
  const [themePack, setThemePack] = useState<ThemePack>(
    settings?.theme_pack ?? "neutral",
  );
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    settings?.theme_mode ?? "dark",
  );
  const [host, setHost] = useState(settings?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(settings?.port ?? 3001));
  const [commitMode, setCommitMode] = useState(
    settings?.commit_mode ?? "pull_request",
  );
  const [modelSettings, setModelSettings] = useState<ModelSettings>(
    models?.settings ?? DEFAULT_MODEL_SETTINGS,
  );
  const [message, setMessage] = useState("");
  const [piLoginSession, setPiLoginSession] = useState<TerminalSession | null>(
    null,
  );

  useEffect(() => {
    if (!settings) return;
    setThemePack(settings.theme_pack);
    setThemeMode(settings.theme_mode);
    setHost(settings.host);
    setPort(String(settings.port));
    setCommitMode(settings.commit_mode);
  }, [settings]);

  useEffect(() => {
    if (models) setModelSettings(models.settings);
  }, [models]);

  const saveBasic = async () => {
    const saved = await api<BasicSettings>("/settings/basic", {
      method: "PUT",
      body: JSON.stringify({
        theme_pack: themePack,
        theme_mode: themeMode,
        host,
        port: Number(port),
        commit_mode: commitMode,
        confirmed_external: host === "0.0.0.0",
      }),
    });
    setMessage("基础设置已保存。");
    await appData.loadSettings();
    if (saved.restart_required) {
      const restart = await api<{ accepted: boolean; next_url: string }>(
        "/system/restart",
        { method: "POST" },
      );
      window.location.href = restart.next_url;
    }
  };

  const saveTheme = async (
    update: Partial<Pick<BasicSettings, "theme_pack" | "theme_mode">>,
  ) => {
    const previous = { themePack, themeMode };
    const nextPack = update.theme_pack ?? themePack;
    const nextMode = update.theme_mode ?? themeMode;
    setThemePack(nextPack);
    setThemeMode(nextMode);
    document.documentElement.dataset.themePack = nextPack;
    document.documentElement.dataset.themeMode = nextMode;
    try {
      await api<BasicSettings>("/settings/basic", {
        method: "PUT",
        body: JSON.stringify(update),
      });
      await appData.loadSettings();
    } catch (error) {
      setThemePack(previous.themePack);
      setThemeMode(previous.themeMode);
      setMessage(String(error));
    }
  };

  const saveModels = async () => {
    await api<ModelSettingsResponse>("/settings/models", {
      method: "PUT",
      body: JSON.stringify(modelSettings),
    });
    setMessage("模型设置已保存。");
    await appData.loadModels();
  };

  const startPiLogin = async () => {
    const session = await api<TerminalSession>(
      `/projects/${PROJECT_ID}/terminals`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Pi 登录",
          command: "pi --no-session --no-extensions --no-context-files",
          rows: 18,
          cols: 80,
        }),
      },
    );
    setPiLoginSession(session);
    await appData.loadTerminals();
  };

  return (
    <div className="panel-grid two">
      <section className="panel-section">
        <Text type="large" weight="semibold" display="block">
          运行设置
        </Text>
        <label className="field-row">
          <Text type="label">主题包</Text>
          <select
            value={themePack}
            onChange={(event) =>
              void saveTheme({ theme_pack: event.target.value as ThemePack })
            }
          >
            {[
              "neutral",
              "stone",
              "matcha",
              "y2k",
              "chocolate",
              "gothic",
              "butter",
            ].map((pack) => (
              <option key={pack} value={pack}>
                {pack}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <Text type="label">明暗模式</Text>
          <select
            value={themeMode}
            onChange={(event) =>
              void saveTheme({
                theme_mode: event.target.value as BasicSettings["theme_mode"],
              })
            }
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <TextInput label="Host" value={host} onChange={setHost} />
        {host === "0.0.0.0" ? (
          <Token label="会暴露无鉴权 API，请确认网络环境" color="orange" />
        ) : null}
        <TextInput label="Port" value={port} onChange={setPort} />
        <label className="field-row">
          <Text type="label">提交模式</Text>
          <select
            value={commitMode}
            onChange={(event) =>
              setCommitMode(event.target.value as typeof commitMode)
            }
          >
            <option value="pull_request">Pull Request</option>
            <option value="local">Local</option>
          </select>
        </label>
        <Button
          label="保存基础设置"
          variant="primary"
          onClick={() => void saveBasic()}
        />
        {settings?.restart_required ? (
          <Token label="需要重启" color="orange" />
        ) : null}
        <Text type="supporting" color="secondary">
          生效地址：{settings?.effective_host}:{settings?.effective_port}
        </Text>
      </section>

      <section className="panel-section">
        <div className="section-heading-row">
          <Text type="large" weight="semibold" display="block">
            模型设置
          </Text>
          <Token
            label={models?.rpc_status ?? "loading"}
            color={models?.rpc_status === "error" ? "red" : "green"}
          />
        </div>
        {(["low", "medium", "high"] as const).map((tier) => (
          <div className="model-tier-row" key={tier}>
            <label className="field-row">
              <Text type="label">{tier}</Text>
              <select
                value={modelSettings[tier]?.model_id ?? ""}
                onChange={(event) =>
                  setModelSettings((current) => ({
                    ...current,
                    [tier]: {
                      model_id: event.target.value || null,
                      thinking_level:
                        current[tier]?.thinking_level ??
                        (tier as ModelTierSetting["thinking_level"]),
                    },
                  }))
                }
              >
                <option value="">未选择</option>
                {(models?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-row">
              <Text type="label">thinking</Text>
              <select
                value={modelSettings[tier]?.thinking_level ?? tier}
                onChange={(event) =>
                  setModelSettings((current) => ({
                    ...current,
                    [tier]: {
                      model_id: current[tier]?.model_id ?? null,
                      thinking_level: event.target
                        .value as ModelTierSetting["thinking_level"],
                    },
                  }))
                }
              >
                {["off", "minimal", "low", "medium", "high", "xhigh"].map(
                  (level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
        ))}
        <div className="inline-actions">
          <Button
            label="保存模型"
            variant="primary"
            onClick={() => void saveModels()}
          />
          <Button
            label="重载"
            variant="ghost"
            icon={<RefreshCw size={16} />}
            onClick={() =>
              void api<ModelSettingsResponse>("/settings/models/reload", {
                method: "POST",
              }).then(appData.loadModels)
            }
          />
          <Button
            label="启动登录终端"
            variant="ghost"
            icon={<TerminalSquare size={16} />}
            onClick={() => void startPiLogin()}
          />
        </div>
        {(!models?.models.length ||
          !modelSettings.low?.model_id ||
          !modelSettings.medium?.model_id ||
          !modelSettings.high?.model_id) && (
          <Text color="secondary">
            首次使用请启动登录终端，手动输入 /login 后重载模型并保存三档配置。
          </Text>
        )}
        {models?.rpc_error ? (
          <Text color="accent">{models.rpc_error}</Text>
        ) : null}
      </section>
      <section className="panel-section model-terminal-section">
        <div className="section-heading-row">
          <Text type="large" weight="semibold" display="block">
            Pi 登录终端
          </Text>
          {piLoginSession ? (
            <Button
              label="关闭登录终端"
              variant="ghost"
              icon={<X size={16} />}
              onClick={() => setPiLoginSession(null)}
            />
          ) : null}
        </div>
        <TerminalViewport session={piLoginSession} />
      </section>
      {message ? <Text color="accent">{message}</Text> : null}
    </div>
  );
}

function TerminalPanel({
  appData,
}: {
  appData: ReturnType<typeof useAppData>;
}) {
  const access = appData.terminalAccess.data;
  const [keyValue, setKeyValue] = useState("");
  const [active, setActive] = useState<TerminalSession | null>(
    appData.terminals.data?.[0] ?? null,
  );

  useEffect(() => {
    if (!active && appData.terminals.data?.[0])
      setActive(appData.terminals.data[0]);
  }, [active, appData.terminals.data]);

  const unlock = async () => {
    await api<TerminalAccessStatus>(`/projects/${PROJECT_ID}/terminal-access`, {
      method: "POST",
      body: JSON.stringify({ key: keyValue }),
    });
    setKeyValue("");
    await appData.loadTerminalAccess();
  };

  const createTerminal = async () => {
    const session = await api<TerminalSession>(
      `/projects/${PROJECT_ID}/terminals`,
      {
        method: "POST",
        body: JSON.stringify({ title: "项目终端", rows: 24, cols: 96 }),
      },
    );
    setActive(session);
    await appData.loadTerminals();
  };

  const closeTerminal = async (session: TerminalSession) => {
    const sessions = await api<TerminalSession[]>(
      `/projects/${PROJECT_ID}/terminals/${session.id}`,
      { method: "DELETE" },
    );
    await appData.loadTerminals();
    setActive(sessions[0] ?? null);
  };

  if (access?.required && !access.authorized) {
    return (
      <section className="panel-section terminal-unlock">
        <KeyRound size={28} />
        <Text type="large" weight="semibold" display="block">
          需要终端密钥
        </Text>
        <TextInput label="启动密钥" value={keyValue} onChange={setKeyValue} />
        <Button
          label="授权终端"
          variant="primary"
          onClick={() => void unlock()}
        />
      </section>
    );
  }

  return (
    <div className="terminal-panel">
      <aside className="terminal-sidebar">
        <Button
          label="新建终端"
          icon={<Play size={16} />}
          onClick={() => void createTerminal()}
        />
        {(appData.terminals.data ?? []).map((session) => (
          <div
            className={cx(
              "terminal-session-row",
              active?.id === session.id && "is-active",
            )}
            key={session.id}
          >
            <button
              className="row-button terminal-session-select"
              type="button"
              onClick={() => setActive(session)}
            >
              <StatusDot
                variant={
                  session.status === "running"
                    ? "success"
                    : session.status === "starting"
                      ? "accent"
                      : "neutral"
                }
                label={session.status}
                isPulsing={session.status === "starting"}
              />
              <span className="row-main">
                <Text type="label" display="block" maxLines={1}>
                  {session.title}
                </Text>
                <Text type="supporting" color="secondary">
                  {session.status}
                  {session.exit_code !== null && session.exit_code !== undefined
                    ? ` · exit ${session.exit_code}`
                    : ""}
                </Text>
              </span>
            </button>
            <Button
              label="关闭"
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<X size={14} />}
              onClick={() => void closeTerminal(session)}
            />
          </div>
        ))}
      </aside>
      <TerminalViewport session={active} />
    </div>
  );
}

function TerminalViewport({ session }: { session: TerminalSession | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!session || !hostRef.current) return;
    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: "var(--font-family-code)",
      fontSize: 13,
      theme: {
        background: "#111112",
        foreground: "#DFE2E5",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();

    const socket = new WebSocket(
      wsUrl(`/projects/${PROJECT_ID}/terminals/${session.id}/ws`),
    );
    socket.onopen = () => {
      terminal.writeln("\r\n[connected]");
      fit.fit();
      socket.send(
        JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as {
        type: string;
        data?: string;
        message?: string;
        status?: string;
        exit_code?: number | null;
      };
      if (message.type === "output" && message.data)
        terminal.write(message.data);
      if (message.type === "error")
        terminal.writeln(`\r\n${message.message ?? "terminal error"}`);
      if (message.type === "status") {
        terminal.writeln(
          `\r\n[${message.status ?? "status"}${
            message.exit_code === null || message.exit_code === undefined
              ? ""
              : `: ${message.exit_code}`
          }]`,
        );
      }
    };
    socket.onclose = () => terminal.writeln("\r\n[disconnected]");
    const disposable = terminal.onData((input) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data: input }));
      }
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    });
    resizeObserver.observe(hostRef.current);

    return () => {
      disposable.dispose();
      resizeObserver.disconnect();
      socket.close();
      terminal.dispose();
    };
  }, [session]);

  if (!session) {
    return (
      <div className="terminal-empty">
        <Text type="large" weight="semibold">
          没有打开的终端
        </Text>
      </div>
    );
  }

  return <div className="terminal-viewport" ref={hostRef} />;
}

function GitPanel({ appData }: { appData: ReturnType<typeof useAppData> }) {
  const git = appData.git.data;
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<
    "commit" | "push" | null
  >(null);
  const [busy, setBusy] = useState("");
  const paths = Array.from(selectedPaths);

  const runGitAction = async (body: GitAction) => {
    setBusy(body.type);
    try {
      await api<unknown>(`/projects/${PROJECT_ID}/git/actions`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setSelectedPaths(new Set());
      setDiff(null);
      setPendingConfirm(null);
      await appData.loadGit();
    } finally {
      setBusy("");
    }
  };

  const loadDiff = async (path: string, area: "staged" | "unstaged") => {
    setDiff(
      await api<GitDiff>(
        `/projects/${PROJECT_ID}/git/diff?path=${encodeURIComponent(
          path,
        )}&area=${area}`,
      ),
    );
  };

  const togglePath = (path: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="git-workbench">
      <section className="panel-section">
        <div className="section-heading-row">
          <Text type="large" weight="semibold">
            仓库状态
          </Text>
          <div className="inline-actions">
            <Button
              label="刷新"
              variant="ghost"
              icon={<RefreshCw size={16} />}
              onClick={() => void appData.loadGit()}
            />
            <Button
              label="Fetch"
              variant="ghost"
              isDisabled={git?.write_blocked || busy === "fetch"}
              onClick={() => void runGitAction({ type: "fetch" })}
            />
            <Button
              label="Pull"
              variant="ghost"
              isDisabled={git?.write_blocked || busy === "pull"}
              onClick={() => void runGitAction({ type: "pull" })}
            />
          </div>
        </div>
        <div className="metric-strip">
          <Metric label="Branch" value={git?.branch ?? "detached"} />
          <Metric label="Upstream" value={git?.upstream ?? "none"} />
          <Metric label="Ahead" value={formatNumber(git?.ahead)} />
          <Metric label="Behind" value={formatNumber(git?.behind)} />
          <Metric label="Files" value={formatNumber(git?.files.length)} />
        </div>
        {git?.write_blocked ? (
          <Token label={git.blocked_reason ?? "写操作阻塞"} color="orange" />
        ) : null}
        <div className="inline-actions wrap">
          <TextInput
            label="Branch"
            value={branchName}
            onChange={setBranchName}
          />
          <Button
            label="切换"
            variant="ghost"
            isDisabled={!branchName.trim() || git?.write_blocked}
            onClick={() =>
              void runGitAction({
                type: "switch_branch",
                branch: branchName.trim(),
              })
            }
          />
          <Button
            label="新建"
            variant="ghost"
            isDisabled={!branchName.trim() || git?.write_blocked}
            onClick={() =>
              void runGitAction({
                type: "create_branch",
                branch: branchName.trim(),
              })
            }
          />
        </div>
      </section>
      <section className="panel-section list-section git-file-list">
        <div className="section-heading-row">
          <Text type="large" weight="semibold">
            文件
          </Text>
          <div className="inline-actions">
            <Button
              label="Stage"
              variant="ghost"
              isDisabled={!paths.length || git?.write_blocked}
              onClick={() => void runGitAction({ type: "stage", paths: paths })}
            />
            <Button
              label="Unstage"
              variant="ghost"
              isDisabled={!paths.length || git?.write_blocked}
              onClick={() =>
                void runGitAction({ type: "unstage", paths: paths })
              }
            />
          </div>
        </div>
        {(git?.files ?? []).length ? (
          git?.files.map((file) => (
            <div className="data-row git-file-row" key={file.path}>
              <input
                checked={selectedPaths.has(file.path)}
                type="checkbox"
                onChange={() => togglePath(file.path)}
              />
              <FileText size={16} />
              <span className="row-main">
                <Text type="label" maxLines={1}>
                  {file.path}
                </Text>
                {file.original_path ? (
                  <Text type="supporting" color="secondary">
                    from {file.original_path}
                  </Text>
                ) : null}
              </span>
              {file.staged ? (
                <Button
                  label="Staged diff"
                  variant="ghost"
                  size="sm"
                  icon={<Eye size={14} />}
                  onClick={() => void loadDiff(file.path, "staged")}
                />
              ) : null}
              {file.unstaged ? (
                <Button
                  label="Unstaged diff"
                  variant="ghost"
                  size="sm"
                  icon={<Code2 size={14} />}
                  onClick={() => void loadDiff(file.path, "unstaged")}
                />
              ) : null}
              <Token
                label={file.staged ?? file.unstaged ?? "changed"}
                size="sm"
                color="blue"
              />
            </div>
          ))
        ) : (
          <Text color="secondary">工作区干净。</Text>
        )}
      </section>
      <section className="panel-section">
        <Text type="large" weight="semibold" display="block">
          Diff
        </Text>
        {diff ? (
          <>
            <div className="section-heading-row">
              <Token label={diff.area} size="sm" />
              {diff.binary ? <Token label="binary" color="orange" /> : null}
              {diff.truncated ? (
                <Token label="truncated" color="orange" />
              ) : null}
            </div>
            <pre className="diff-preview">
              {diff.binary ? "Binary file." : diff.content}
            </pre>
          </>
        ) : (
          <Text color="secondary">选择一个文件查看 diff。</Text>
        )}
      </section>
      <section className="panel-section">
        <Text type="large" weight="semibold" display="block">
          写操作
        </Text>
        <TextArea
          label="Commit message"
          rows={3}
          value={commitMessage}
          onChange={setCommitMessage}
        />
        <div className="inline-actions">
          <Button
            label="Commit"
            variant="primary"
            icon={<GitCommit size={16} />}
            isDisabled={!commitMessage.trim() || git?.write_blocked}
            onClick={() => setPendingConfirm("commit")}
          />
          <Button
            label="Push"
            variant="ghost"
            icon={<GitPullRequest size={16} />}
            isDisabled={git?.write_blocked}
            onClick={() => setPendingConfirm("push")}
          />
        </div>
        {pendingConfirm ? (
          <div className="confirm-strip">
            <Text type="label">
              确认执行 {pendingConfirm === "commit" ? "commit" : "push"}？
            </Text>
            <Button
              label="确认"
              variant="primary"
              onClick={() =>
                void runGitAction(
                  pendingConfirm === "commit"
                    ? {
                        type: "commit",
                        message: commitMessage.trim(),
                        confirmed: true,
                      }
                    : { type: "push", confirmed: true },
                )
              }
            />
            <Button
              label="取消"
              variant="ghost"
              onClick={() => setPendingConfirm(null)}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function TokenPanel({ usage }: { usage: ProjectTokenUsage | null }) {
  if (!usage) {
    return (
      <section className="panel-section">
        <Text type="large" weight="semibold">
          暂无 token 使用摘要
        </Text>
      </section>
    );
  }
  return (
    <div className="panel-stack">
      <section className="panel-section">
        <ProgressBar
          label="上下文窗口"
          value={usage.context_percent}
          max={100}
          hasValueLabel
          variant={
            usage.context_percent > 85
              ? "error"
              : usage.context_percent > 65
                ? "warning"
                : "accent"
          }
        />
      </section>
      <div className="metric-strip grid">
        <Metric label="Input" value={formatNumber(usage.input)} />
        <Metric label="Output" value={formatNumber(usage.output)} />
        <Metric label="Cache read" value={formatNumber(usage.cache_read)} />
        <Metric label="Cache write" value={formatNumber(usage.cache_write)} />
        <Metric label="Context" value={formatNumber(usage.context_tokens)} />
        <Metric label="Window" value={formatNumber(usage.context_window)} />
      </div>
    </div>
  );
}

function RequirementsPanel({
  appData,
}: {
  appData: ReturnType<typeof useAppData>;
}) {
  const [message, setMessage] = useState("");
  const [selectedRequirementId, setSelectedRequirementId] = useState<
    string | null
  >(appData.canvas.data?.active_requirement?.id ?? null);
  const [dagRequirement, setDagRequirement] = useState<Requirement | null>(
    null,
  );
  const [selectedTask, setSelectedTask] =
    useState<RequirementExecutionTask | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const requirements = dedupeRequirements([
    ...(appData.canvas.data?.active_requirement
      ? [appData.canvas.data.active_requirement]
      : []),
    ...(appData.canvas.data?.queued_requirements ?? []),
    ...(appData.canvas.data?.completed_requirements ?? []),
  ]);
  const pending = requirements.filter((item) => item.status !== "completed");
  const completed = requirements.filter((item) => item.status === "completed");

  useEffect(() => {
    if (!selectedRequirementId && requirements[0]) {
      setSelectedRequirementId(requirements[0].id);
    }
  }, [requirements, selectedRequirementId]);

  useEffect(() => {
    if (!selectedRequirementId) {
      setDagRequirement(null);
      return;
    }
    let cancelled = false;
    void api<ProjectCanvasData>(
      `/projects/${PROJECT_ID}/canvas?dag_requirement_id=${encodeURIComponent(
        selectedRequirementId,
      )}`,
    ).then((canvas) => {
      if (cancelled) return;
      const match = dedupeRequirements([
        ...(canvas.active_requirement ? [canvas.active_requirement] : []),
        ...canvas.queued_requirements,
        ...canvas.completed_requirements,
      ]).find((item) => item.id === selectedRequirementId);
      setDagRequirement(match ?? null);
      setSelectedTask(match?.execution_plan?.tasks[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRequirementId]);

  const create = async () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    await api<{ accepted: boolean }>(`/projects/${PROJECT_ID}/requirements`, {
      method: "POST",
      body: JSON.stringify({ message: trimmed, references: [], images: [] }),
    });
    setMessage("");
    await appData.loadCanvas();
  };

  const planRequirement = async (requirement: Requirement) => {
    setBusyAction(`plan:${requirement.id}`);
    try {
      await api<unknown>(`/requirements/${requirement.id}/plan`, {
        method: "POST",
      });
      await appData.loadCanvas();
      setSelectedRequirementId(requirement.id);
    } finally {
      setBusyAction("");
    }
  };

  const recoverTask = async (requirementId: string, taskId: string) => {
    setBusyAction(`recover:${taskId}`);
    try {
      await api<unknown>(
        `/requirements/${requirementId}/tasks/${taskId}/recover`,
        { method: "POST" },
      );
      await appData.loadCanvas();
      setSelectedRequirementId(requirementId);
    } finally {
      setBusyAction("");
    }
  };

  const renderRequirementRows = (items: Requirement[]) =>
    items.map((item) => (
      <button
        className={cx(
          "data-row tall selectable-row",
          selectedRequirementId === item.id && "is-active",
        )}
        key={item.id}
        type="button"
        onClick={() => setSelectedRequirementId(item.id)}
      >
        {iconForRequirement(item.status)}
        <span className="row-main">
          <Text type="label" display="block" maxLines={1}>
            {item.title}
          </Text>
          <Text
            type="supporting"
            color="secondary"
            display="block"
            maxLines={2}
          >
            {item.error ?? item.original_message ?? item.status}
          </Text>
          <Text type="supporting" color="secondary" display="block">
            {new Date(item.updated_at).toLocaleString()} ·{" "}
            {requirementProgress(item)}
          </Text>
        </span>
        <Token
          label={item.status}
          color={statusVariant(item.status) === "error" ? "red" : "blue"}
          size="sm"
        />
      </button>
    ));

  const tasks = dagRequirement?.execution_plan?.tasks ?? [];

  return (
    <div className="requirements-workbench">
      <section className="panel-section list-section">
        <div className="section-heading-row">
          <Text type="large" weight="semibold" display="block">
            待处理
          </Text>
          <Token label={String(pending.length)} size="sm" />
        </div>
        {pending.length ? renderRequirementRows(pending) : null}
        <div className="section-heading-row section-gap">
          <Text type="large" weight="semibold" display="block">
            已完成
          </Text>
          <Token label={String(completed.length)} size="sm" />
        </div>
        {completed.length ? renderRequirementRows(completed) : null}
        {!requirements.length ? (
          <Text color="secondary">还没有需求。</Text>
        ) : null}
      </section>
      <section className="requirements-canvas panel-section">
        <div className="section-heading-row">
          <div>
            <Text type="large" weight="semibold" display="block">
              {dagRequirement?.title ?? "执行子画布"}
            </Text>
            <Text type="supporting" color="secondary" display="block">
              {dagRequirement?.execution_plan?.summary ??
                "选择左侧需求后查看 DAG 与任务。"}
            </Text>
          </div>
          {dagRequirement?.status === "failed" &&
          !dagRequirement.execution_plan ? (
            <Button
              label="重新生成 DAG"
              variant="primary"
              icon={<RefreshCw size={16} />}
              isDisabled={busyAction === `plan:${dagRequirement.id}`}
              onClick={() => void planRequirement(dagRequirement)}
            />
          ) : null}
        </div>
        {tasks.length ? (
          <div className="task-graph">
            {tasks.map((task, index) => (
              <button
                className={cx(
                  "task-node",
                  selectedTask?.id === task.id && "is-active",
                  `task-${task.status}`,
                )}
                key={task.id}
                style={{
                  gridColumn: 1 + (index % 3),
                  gridRow: 1 + Math.floor(index / 3),
                }}
                type="button"
                onClick={() => setSelectedTask(task)}
              >
                <Text type="label" display="block" maxLines={1}>
                  {task.title}
                </Text>
                <Text type="supporting" color="secondary" display="block">
                  {task.kind}
                </Text>
                <Token
                  label={task.status}
                  color={task.status === "failed" ? "red" : "blue"}
                  size="sm"
                />
                {task.execution_warning ? (
                  <Text type="supporting" color="accent" maxLines={2}>
                    {task.execution_warning}
                  </Text>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Text color="secondary">
              {dagRequirement
                ? "该需求尚未生成执行计划。"
                : "选择一个需求查看任务关系。"}
            </Text>
          </div>
        )}
        {selectedTask ? (
          <section className="task-detail">
            <div className="section-heading-row">
              <div>
                <Text type="large" weight="semibold" display="block">
                  {selectedTask.title}
                </Text>
                <Text type="supporting" color="secondary" display="block">
                  {selectedTask.kind} · depends on{" "}
                  {selectedTask.depends_on.length || "none"}
                </Text>
              </div>
              {selectedTask.status === "failed" && dagRequirement ? (
                <Button
                  label="恢复任务"
                  variant="primary"
                  icon={<RefreshCw size={16} />}
                  isDisabled={busyAction === `recover:${selectedTask.id}`}
                  onClick={() =>
                    void recoverTask(dagRequirement.id, selectedTask.id)
                  }
                />
              ) : null}
            </div>
            <Markdown density="compact">
              {selectedTask.failure_summary ??
                selectedTask.result_summary ??
                selectedTask.description}
            </Markdown>
            <div className="chip-row">
              {(selectedTask.target_files ?? []).map((file) => (
                <Token key={file} label={file} color="blue" size="sm" />
              ))}
              {selectedTask.pull_request_url ? (
                <Token label="PR" color="green" size="sm" />
              ) : null}
              {selectedTask.merged_into ? (
                <Token label={`merged ${selectedTask.merged_into}`} size="sm" />
              ) : null}
            </div>
          </section>
        ) : null}
      </section>
      <section className="panel-section requirement-create">
        <Text type="large" weight="semibold" display="block">
          新需求
        </Text>
        <TextArea
          label="需求描述"
          value={message}
          onChange={setMessage}
          rows={6}
          placeholder="描述你希望仓库完成的变化..."
        />
        <Button
          label="提交需求"
          variant="primary"
          onClick={() => void create()}
        />
      </section>
    </div>
  );
}

function FilesPanel() {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [tabs, setTabs] = useState<Array<{ path: string; content: string }>>(
    [],
  );
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const selected = tabs.find((tab) => tab.path === activePath) ?? null;

  const search = async () => {
    setError("");
    try {
      const body = await api<unknown>(
        `/projects/${PROJECT_ID}/files?search=${encodeURIComponent(query)}`,
      );
      const raw = Array.isArray(body)
        ? body
        : Array.isArray((body as { files?: unknown[] }).files)
          ? (body as { files: unknown[] }).files
          : [];
      setFiles(
        raw.map((item) =>
          typeof item === "string"
            ? { path: item }
            : { path: String((item as { path?: string }).path ?? "") },
        ),
      );
    } catch (err) {
      setError(String(err));
    }
  };

  const openFile = async (path: string) => {
    const body = await api<{ path: string; content: string }>(
      `/projects/${PROJECT_ID}/files/content?path=${encodeURIComponent(path)}`,
    );
    setTabs((current) =>
      current.some((item) => item.path === body.path)
        ? current
        : [...current, body],
    );
    setActivePath(body.path);
  };

  const closeTab = (path: string) => {
    setTabs((current) => current.filter((tab) => tab.path !== path));
    if (activePath === path) {
      const next = tabs.find((tab) => tab.path !== path);
      setActivePath(next?.path ?? null);
    }
  };

  const grouped = files.reduce<Record<string, FileEntry[]>>((groups, file) => {
    const folder = file.path.includes("/")
      ? file.path.split("/").slice(0, -1).join("/")
      : ".";
    groups[folder] = [...(groups[folder] ?? []), file];
    return groups;
  }, {});

  return (
    <div className="files-panel">
      <aside className="file-list">
        <form
          className="search-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void search();
          }}
        >
          <TextInput label="搜索文件" value={query} onChange={setQuery} />
          <Button label="搜索" icon={<Folder size={16} />} type="submit" />
        </form>
        {error ? <Text color="accent">{error}</Text> : null}
        {Object.entries(grouped).map(([folder, entries]) => (
          <section className="file-tree-group" key={folder}>
            <Text type="supporting" color="secondary" display="block">
              {folder}
            </Text>
            {entries.map((file) => (
              <button
                className={cx(
                  "row-button",
                  activePath === file.path && "is-active",
                )}
                key={file.path}
                type="button"
                onClick={() => void openFile(file.path)}
              >
                <FileText size={15} />
                <Text type="label" maxLines={1}>
                  {file.path.split("/").at(-1) ?? file.path}
                </Text>
              </button>
            ))}
          </section>
        ))}
      </aside>
      <section className="file-editor">
        <div className="file-tabs">
          {tabs.map((tab) => (
            <button
              className={cx("file-tab", activePath === tab.path && "is-active")}
              key={tab.path}
              type="button"
              onClick={() => setActivePath(tab.path)}
            >
              <Text type="label" maxLines={1}>
                {tab.path}
              </Text>
              <X
                size={13}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.path);
                }}
              />
            </button>
          ))}
        </div>
        <div className="file-preview">
          {selected ? (
            selected.path.toLowerCase().endsWith(".md") ? (
              <Markdown density="compact">{selected.content}</Markdown>
            ) : (
              <pre className="code-preview">{selected.content}</pre>
            )
          ) : (
            <div className="empty-state">
              <Text color="secondary">选择文件后在这里预览。</Text>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="metric">
      <Text type="supporting" color="secondary" display="block">
        {label}
      </Text>
      <Text type="large" display="block" maxLines={1}>
        {value}
      </Text>
    </div>
  );
}
