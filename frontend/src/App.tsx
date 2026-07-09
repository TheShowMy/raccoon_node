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
  FileText,
  Files,
  Folder,
  Gauge,
  GitBranch,
  KeyRound,
  MessageSquare,
  Play,
  RefreshCw,
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

const PROJECT_ID = "current";
const CHAT_SIZE = { width: 960, height: 760 };
const ORBIT_NODE_SIZE = { width: 184, height: 116 };
const CENTER = { x: 0, y: 0 };
const ELLIPSE = { rx: 860, ry: 620 };
const PANEL_GAP = 310;
const PARALLAX_MAX = 260;

type RequirementStatus =
  | "analyzing"
  | "clarifying"
  | "draft_ready"
  | "planning"
  | "queued"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

type Requirement = {
  id: string;
  title: string;
  original_message?: string;
  status: RequirementStatus;
  created_at: string;
  updated_at: string;
  error?: string | null;
};

type ProjectTokenUsage = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  context_tokens: number;
  context_window: number;
  context_percent: number;
};

type ProjectCanvasResponse = {
  project: { id: string; name: string; local_path: string; git_url: string };
  active_requirement: Requirement | null;
  queued_requirements: Requirement[];
  completed_requirements: Requirement[];
  token_usage: ProjectTokenUsage | null;
};

type ProjectChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
};

type ProjectChatResponse = {
  messages: ProjectChatMessage[];
  running: boolean;
  error: string | null;
  requirement_summary?: {
    title: string;
    summary: string;
    acceptance_criteria: string[];
  } | null;
};

type BasicSettings = {
  theme_pack: string;
  theme_mode: "light" | "dark" | "system";
  host: string;
  port: number;
  effective_host: string;
  effective_port: number;
  restart_required: boolean;
  commit_mode: "pull_request" | "local";
};

type PiModel = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
};

type ModelTierSetting = {
  model_id: string;
  thinking_level: "low" | "medium" | "high";
};

type ModelSettingsResponse = {
  models: PiModel[];
  settings: Partial<Record<"low" | "medium" | "high", ModelTierSetting>>;
  rpc_status: "ready" | "reconnecting" | "error";
  rpc_error: string | null;
};

type GitStatusResponse = {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  remote_configured: boolean;
  write_blocked: boolean;
  blocked_reason: string | null;
  files: Array<{
    path: string;
    original_path?: string | null;
    staged?: string | null;
    unstaged?: string | null;
  }>;
};

type TerminalAccessStatus = {
  required: boolean;
  authorized: boolean;
  expires_at: string | null;
};

type TerminalSession = {
  id: string;
  title: string;
  command?: string | null;
  status: "starting" | "running" | "exited";
  exit_code?: number | null;
};

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

function iconForRequirement(status: RequirementStatus): ReactNode {
  const className = cx("node-icon", `status-${status}`);
  return <ClipboardList className={className} size={24} />;
}

function statusVariant(status?: RequirementStatus): OrbitNodeData["status"] {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (
    status === "executing" ||
    status === "planning" ||
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
    useState<LoadedState<ProjectCanvasResponse>>(makeLoaded());
  const [chat, setChat] =
    useState<LoadedState<ProjectChatResponse>>(makeLoaded());
  const [settings, setSettings] =
    useState<LoadedState<BasicSettings>>(makeLoaded());
  const [models, setModels] =
    useState<LoadedState<ModelSettingsResponse>>(makeLoaded());
  const [git, setGit] = useState<LoadedState<GitStatusResponse>>(makeLoaded());
  const [terminals, setTerminals] = useState<LoadedState<TerminalSession[]>>(
    makeLoaded([]),
  );
  const [terminalAccess, setTerminalAccess] =
    useState<LoadedState<TerminalAccessStatus>>(makeLoaded());
  const [eventLine, setEventLine] = useState("Ready.");

  const loadCanvas = useCallback(async () => {
    setCanvas((state) => ({ ...state, loading: true }));
    try {
      const data = await api<ProjectCanvasResponse>(
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
      const data = await api<GitStatusResponse>(
        `/projects/${PROJECT_ID}/git/status`,
      );
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
    return Math.min(
      1,
      safeWidth / CHAT_SIZE.width,
      safeHeight / CHAT_SIZE.height,
    );
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
          executing: 0,
          planning: 1,
          analyzing: 2,
          clarifying: 3,
          draft_ready: 4,
          queued: 5,
          failed: 6,
          completed: 7,
          cancelled: 8,
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
      return { width: 760, height: 620 };
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
  const [submitting, setSubmitting] = useState(false);
  const chat = appData.chat.data;

  const send = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || chat?.running || submitting) return;
    setSubmitting(true);
    try {
      await api<{ accepted: boolean }>(
        `/projects/${PROJECT_ID}/chat/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            message: trimmed,
            references: [],
            images: [],
          }),
        },
      );
      setValue("");
      await appData.loadChat();
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

  const generateRequirementSummary = async () => {
    await api<{ accepted: boolean }>(
      `/projects/${PROJECT_ID}/chat/commands/requirement-summary`,
      {
        method: "POST",
      },
    );
    await appData.loadChat();
  };

  return (
    <section
      className="chat-node nodrag nopan"
      style={{ width: CHAT_SIZE.width, height: CHAT_SIZE.height }}
    >
      <header className="chat-node-header">
        <div>
          <Text type="large" weight="semibold" display="block">
            项目对话
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
            label={chat?.running ? "生成中" : "就绪"}
            color={chat?.running ? "blue" : "green"}
            size="sm"
          />
          <Button
            label="生成需求说明"
            variant="ghost"
            size="sm"
            onClick={() => void generateRequirementSummary()}
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
            placeholder="询问项目，或输入 /生成需求说明"
            drawer={
              <ChatComposerDrawer
                count={chat?.requirement_summary ? 1 : 0}
                label="上下文"
              >
                {chat?.requirement_summary ? (
                  <Token
                    label={chat.requirement_summary.title}
                    color="purple"
                    size="sm"
                  />
                ) : null}
              </ChatComposerDrawer>
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
  const [host, setHost] = useState(settings?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(settings?.port ?? 3001));
  const [commitMode, setCommitMode] = useState(
    settings?.commit_mode ?? "pull_request",
  );
  const [modelSettings, setModelSettings] = useState(models?.settings ?? {});
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!settings) return;
    setHost(settings.host);
    setPort(String(settings.port));
    setCommitMode(settings.commit_mode);
  }, [settings]);

  useEffect(() => {
    if (models) setModelSettings(models.settings);
  }, [models]);

  const saveBasic = async () => {
    await api<BasicSettings>("/settings/basic", {
      method: "PUT",
      body: JSON.stringify({
        host,
        port: Number(port),
        commit_mode: commitMode,
        confirmed_external: host === "0.0.0.0",
      }),
    });
    setMessage("基础设置已保存。");
    await appData.loadSettings();
  };

  const saveModels = async () => {
    await api<ModelSettingsResponse>("/settings/models", {
      method: "PUT",
      body: JSON.stringify(modelSettings),
    });
    setMessage("模型设置已保存。");
    await appData.loadModels();
  };

  return (
    <div className="panel-grid two">
      <section className="panel-section">
        <Text type="large" weight="semibold" display="block">
          运行设置
        </Text>
        <TextInput label="Host" value={host} onChange={setHost} />
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
          <label className="field-row" key={tier}>
            <Text type="label">{tier}</Text>
            <select
              value={modelSettings[tier]?.model_id ?? ""}
              onChange={(event) =>
                setModelSettings((current) => ({
                  ...current,
                  [tier]: {
                    model_id: event.target.value,
                    thinking_level: tier,
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
        </div>
        {models?.rpc_error ? (
          <Text color="accent">{models.rpc_error}</Text>
        ) : null}
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
          <button
            className={cx(
              "row-button",
              active?.id === session.id && "is-active",
            )}
            key={session.id}
            type="button"
            onClick={() => setActive(session)}
          >
            <Text type="label" display="block" maxLines={1}>
              {session.title}
            </Text>
            <Text type="supporting" color="secondary">
              {session.status}
            </Text>
          </button>
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
      };
      if (message.type === "output" && message.data)
        terminal.write(message.data);
      if (message.type === "error")
        terminal.writeln(`\r\n${message.message ?? "terminal error"}`);
    };
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
  return (
    <div className="panel-stack">
      <section className="panel-section">
        <div className="section-heading-row">
          <Text type="large" weight="semibold">
            仓库状态
          </Text>
          <Button
            label="刷新"
            variant="ghost"
            icon={<RefreshCw size={16} />}
            onClick={() => void appData.loadGit()}
          />
        </div>
        <div className="metric-strip">
          <Metric label="Branch" value={git?.branch ?? "detached"} />
          <Metric label="Ahead" value={formatNumber(git?.ahead)} />
          <Metric label="Behind" value={formatNumber(git?.behind)} />
          <Metric label="Files" value={formatNumber(git?.files.length)} />
        </div>
        {git?.write_blocked ? (
          <Token label={git.blocked_reason ?? "写操作阻塞"} color="orange" />
        ) : null}
      </section>
      <section className="panel-section list-section">
        {(git?.files ?? []).length ? (
          git?.files.map((file) => (
            <div className="data-row" key={file.path}>
              <FileText size={16} />
              <Text type="label" maxLines={1}>
                {file.path}
              </Text>
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
  const requirements = [
    ...(appData.canvas.data?.active_requirement
      ? [appData.canvas.data.active_requirement]
      : []),
    ...(appData.canvas.data?.queued_requirements ?? []),
    ...(appData.canvas.data?.completed_requirements ?? []),
  ];

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

  return (
    <div className="panel-grid two">
      <section className="panel-section list-section">
        <Text type="large" weight="semibold" display="block">
          队列
        </Text>
        {requirements.length ? (
          requirements.map((item) => (
            <div className="data-row tall" key={item.id}>
              {iconForRequirement(item.status)}
              <div className="row-main">
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
              </div>
              <Token
                label={item.status}
                color={statusVariant(item.status) === "error" ? "red" : "blue"}
                size="sm"
              />
            </div>
          ))
        ) : (
          <Text color="secondary">还没有需求。</Text>
        )}
      </section>
      <section className="panel-section">
        <Text type="large" weight="semibold" display="block">
          新需求
        </Text>
        <TextArea
          label="需求描述"
          value={message}
          onChange={setMessage}
          rows={8}
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
  const [selected, setSelected] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [error, setError] = useState("");

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
    setSelected(body);
  };

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
        {files.map((file) => (
          <button
            className="row-button"
            key={file.path}
            type="button"
            onClick={() => void openFile(file.path)}
          >
            <Text type="label" maxLines={1}>
              {file.path}
            </Text>
          </button>
        ))}
      </aside>
      <pre className="file-preview">
        {selected ? selected.content : "选择文件后在这里预览。"}
      </pre>
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
