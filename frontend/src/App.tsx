import React, { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  Panel,
  type Rect,
  type Viewport as CanvasViewport,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useViewport,
} from "@xyflow/react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./styles/index.css";

import type {
  GitExpansionPhase,
  StartNodeData,
  StreamEvent,
} from "./types/api";
import StartNode from "./components/nodes/StartNode";
import { buildRequirementDagEdges } from "./canvas/edges";
import {
  buildProjectChatNode,
  buildProjectGitNode,
  buildProjectNodes,
  buildProjectSettingsNode,
  buildProjectTerminalNode,
  mergeProjectNodes,
} from "./canvas/buildProjectNodes";
import { useCurrentProject } from "./hooks/useCurrentProject";
import { useProjectCanvas } from "./hooks/useProjectCanvas";
import { useRequirementFlow } from "./hooks/useRequirementFlow";
import { useProjectChat } from "./hooks/useProjectChat";
import { useModelSettings } from "./hooks/useModelSettings";
import { useProjectTerminals } from "./hooks/useProjectTerminals";
import { useProjectGit } from "./hooks/useProjectGit";
import { RequirementTaskEventsProvider } from "./contexts/RequirementTaskEventsContext";

const nodeTypes = { startNode: StartNode };
const EMPTY_STREAM_EVENTS: StreamEvent[] = [];
const REQUIREMENT_HOME_NODE_IDS = new Set([
  "completed-requirements",
  "requirement-chat",
  "queued-requirements",
]);

export type RequirementsReturnDirection = "left" | "right" | "up" | "down";

export function getRequirementsReturnDirection(
  rects: Rect[],
  viewport: CanvasViewport,
  width: number,
  height: number,
): RequirementsReturnDirection | null {
  if (rects.length === 0 || width === 0 || height === 0) return null;
  const screenRects = rects.map((rect) => ({
    left: rect.x * viewport.zoom + viewport.x,
    right: (rect.x + rect.width) * viewport.zoom + viewport.x,
    top: rect.y * viewport.zoom + viewport.y,
    bottom: (rect.y + rect.height) * viewport.zoom + viewport.y,
  }));
  if (
    screenRects.some(
      (rect) =>
        rect.right > 0 &&
        rect.left < width &&
        rect.bottom > 0 &&
        rect.top < height,
    )
  ) {
    return null;
  }

  const centerX =
    (Math.min(...screenRects.map((rect) => rect.left)) +
      Math.max(...screenRects.map((rect) => rect.right))) /
    2;
  const centerY =
    (Math.min(...screenRects.map((rect) => rect.top)) +
      Math.max(...screenRects.map((rect) => rect.bottom))) /
    2;
  const dx = (centerX - width / 2) / width;
  const dy = (centerY - height / 2) / height;
  return Math.abs(dx) >= Math.abs(dy)
    ? dx < 0
      ? "left"
      : "right"
    : dy < 0
      ? "up"
      : "down";
}

function RequirementsReturnButton({ nodes }: { nodes: Node<StartNodeData>[] }) {
  const viewport = useViewport();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { fitView } = useReactFlow();
  const rects = nodes.map((node) => ({
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? 0,
    height: node.height ?? 0,
  }));
  const direction = getRequirementsReturnDirection(
    rects,
    viewport,
    width,
    height,
  );
  if (!direction) return null;

  const positions = {
    left: "center-left",
    right: "center-right",
    up: "top-center",
    down: "bottom-center",
  } as const;
  const icons = {
    left: ArrowLeft,
    right: ArrowRight,
    up: ArrowUp,
    down: ArrowDown,
  };
  const Icon = icons[direction];

  return (
    <Panel
      className={`requirements-return-panel requirements-return-panel--${direction}`}
      position={positions[direction]}
    >
      <button
        type="button"
        aria-label={`返回需求会话区域（${direction}）`}
        onClick={() =>
          void fitView({
            nodes,
            padding: 0.08,
            maxZoom: viewport.zoom,
            duration: 260,
          })
        }
      >
        <Icon size={16} />
        <span>返回需求会话</span>
      </button>
    </Panel>
  );
}

type ModelSetupGuideStep = "settings" | "models";

function ModelSetupGuide({
  step,
  onSkip,
}: {
  step: ModelSetupGuideStep;
  onSkip: () => void;
}) {
  const viewport = useViewport();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const [target, setTarget] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  React.useLayoutEffect(() => {
    const element = document.querySelector<HTMLElement>(
      `[data-model-setup-target="${step}"]`,
    );
    const flow = element?.closest<HTMLElement>(".react-flow");
    if (!element || !flow) {
      setTarget(null);
      return;
    }

    let frame = 0;
    const trackUntil = performance.now() + 350;
    const update = () => {
      const elementRect = element.getBoundingClientRect();
      const flowRect = flow.getBoundingClientRect();
      const padding = 8;
      const x = Math.max(0, elementRect.left - flowRect.left - padding);
      const y = Math.max(0, elementRect.top - flowRect.top - padding);
      const right = Math.min(
        width,
        elementRect.right - flowRect.left + padding,
      );
      const bottom = Math.min(
        height,
        elementRect.bottom - flowRect.top + padding,
      );
      const next = {
        x,
        y,
        width: Math.max(0, right - x),
        height: Math.max(0, bottom - y),
      };
      setTarget((current) =>
        current &&
        current.x === next.x &&
        current.y === next.y &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
      if (performance.now() < trackUntil) {
        frame = window.requestAnimationFrame(update);
      }
    };

    update();
    return () => window.cancelAnimationFrame(frame);
  }, [height, step, viewport.x, viewport.y, viewport.zoom, width]);

  const stopInteraction = (event: React.SyntheticEvent) =>
    event.stopPropagation();
  const blockers = target
    ? [
        { left: 0, top: 0, width, height: target.y },
        {
          left: 0,
          top: target.y,
          width: target.x,
          height: target.height,
        },
        {
          left: target.x + target.width,
          top: target.y,
          width: Math.max(0, width - target.x - target.width),
          height: target.height,
        },
        {
          left: 0,
          top: target.y + target.height,
          width,
          height: Math.max(0, height - target.y - target.height),
        },
      ]
    : [{ left: 0, top: 0, width, height }];

  return (
    <Panel className="model-setup-guide" position="top-left">
      {blockers.map((style, index) => (
        <div
          className="model-setup-guide__blocker"
          key={index}
          style={style}
          onPointerDown={stopInteraction}
          onClick={stopInteraction}
          onWheel={stopInteraction}
        />
      ))}
      {target ? (
        <div
          className="model-setup-guide__spotlight"
          style={{
            left: target.x,
            top: target.y,
            width: target.width,
            height: target.height,
          }}
        />
      ) : null}
      <div
        className="model-setup-guide__card"
        role="dialog"
        aria-label="模型配置新手引导"
      >
        <span>第 {step === "settings" ? "1" : "2"}/2 步</span>
        <strong>
          {step === "settings"
            ? "点击左上角的「设置」节点"
            : "点击设置工作台中的「模型设置」"}
        </strong>
        <p>
          {step === "settings"
            ? "从设置工作台开始配置 Pi 模型。"
            : "进入后按页面提示登录 Pi 并配置低、中、高三档模型。"}
        </p>
        <button type="button" onClick={onSkip}>
          跳过引导
        </button>
      </div>
    </Panel>
  );
}

export type ProjectViewportSnapshot = {
  projectLoaded: boolean;
  selectedDagRequirementId: string | null;
};

export function getProjectViewportAction(
  previous: ProjectViewportSnapshot,
  current: ProjectViewportSnapshot,
): "fit" | "focus-dag" | null {
  if (!current.projectLoaded) return null;
  if (previous.selectedDagRequirementId && !current.selectedDagRequirementId) {
    return "fit";
  }
  if (
    current.selectedDagRequirementId &&
    current.selectedDagRequirementId !== previous.selectedDagRequirementId
  ) {
    return "focus-dag";
  }
  return null;
}

export function getReactFlowKey({
  projectId,
  projectLoaded,
}: {
  projectId: string | null;
  projectLoaded: boolean;
}) {
  return `project-${projectId ?? "none"}-${projectLoaded ? "ready" : "loading"}`;
}

function ProjectCanvasViewportController({
  projectLoaded,
  selectedDagRequirementId,
}: ProjectViewportSnapshot) {
  const { fitView, getNode, getViewport, setCenter } = useReactFlow();
  const previous = React.useRef<ProjectViewportSnapshot>({
    projectLoaded: false,
    selectedDagRequirementId: null,
  });

  React.useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { projectLoaded, selectedDagRequirementId };

    const action = getProjectViewportAction(last, previous.current);
    if (!action) return;
    if (action === "fit") {
      void fitView({ padding: 0.08, duration: 0 });
      return;
    }

    const timer = window.setTimeout(() => {
      const dagNode = getNode("requirement-dag");
      if (!dagNode) return;

      const width = dagNode.measured?.width ?? dagNode.width ?? 360;
      const height = dagNode.measured?.height ?? dagNode.height ?? 260;
      const zoom = getViewport().zoom;
      void setCenter(
        dagNode.position.x + width / 2,
        dagNode.position.y + height / 2,
        { zoom, duration: 260 },
      );
    }, 80);

    return () => window.clearTimeout(timer);
  }, [
    fitView,
    getNode,
    getViewport,
    projectLoaded,
    selectedDagRequirementId,
    setCenter,
  ]);

  return null;
}

export function getTerminalViewportAction(
  previousCollapsed: boolean,
  currentCollapsed: boolean,
): "focus" | "restore" | null {
  if (previousCollapsed === currentCollapsed) return null;
  return currentCollapsed ? "restore" : "focus";
}

export function getSettingsViewportAction(
  previousExpanded: boolean,
  currentExpanded: boolean,
): "focus" | "restore" | null {
  if (previousExpanded === currentExpanded) return null;
  return currentExpanded ? "focus" : "restore";
}

function SettingsViewportController({
  expanded,
  node,
}: {
  expanded: boolean;
  node: Node<StartNodeData> | null;
}) {
  const { getViewport, setCenter, setViewport } = useReactFlow();
  const previousExpanded = React.useRef(expanded);
  const savedViewport = React.useRef<CanvasViewport | undefined>(undefined);

  React.useLayoutEffect(() => {
    const action = getSettingsViewportAction(
      previousExpanded.current,
      expanded,
    );
    previousExpanded.current = expanded;
    if (!action || !node) return;

    if (action === "restore") {
      const saved = savedViewport.current;
      savedViewport.current = undefined;
      if (saved) void setViewport(saved, { duration: 260 });
      return;
    }

    const saved = getViewport();
    savedViewport.current = saved;
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const width = node.width ?? 1320;
    const height = node.height ?? 780;
    void setCenter(node.position.x + width / 2, node.position.y + height / 2, {
      zoom: saved.zoom,
      duration: reduced ? 0 : 260,
    });
  }, [expanded, getViewport, node, setCenter, setViewport]);

  return null;
}

function TerminalViewportController({ collapsed }: { collapsed: boolean }) {
  const { fitView, getNode, getViewport, setViewport } = useReactFlow();
  const previousCollapsed = React.useRef(collapsed);
  const savedViewport = React.useRef<CanvasViewport | undefined>(undefined);

  React.useLayoutEffect(() => {
    const action = getTerminalViewportAction(
      previousCollapsed.current,
      collapsed,
    );
    previousCollapsed.current = collapsed;
    if (!action) return;

    if (action === "restore") {
      const saved = savedViewport.current;
      savedViewport.current = undefined;
      if (saved) void setViewport(saved, { duration: 260 });
      return;
    }

    const saved = getViewport();
    savedViewport.current = saved;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const terminalNode = getNode("project-terminal");
        if (!terminalNode) return;
        void fitView({
          nodes: [terminalNode],
          padding: 0.08,
          maxZoom: saved.zoom,
          duration: 260,
        });
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [collapsed, fitView, getNode, getViewport, setViewport]);

  return null;
}

function GitViewportController({ phase }: { phase: GitExpansionPhase }) {
  const { fitView, getNode, getViewport, setViewport } = useReactFlow();
  const previous = React.useRef<GitExpansionPhase>("collapsed");
  const savedViewport = React.useRef<CanvasViewport | undefined>(undefined);

  React.useLayoutEffect(() => {
    const last = previous.current;
    previous.current = phase;
    if (last === "collapsed" && phase !== "collapsed") {
      savedViewport.current = getViewport();
    }
    if (phase === "collapsed") {
      const saved = savedViewport.current;
      savedViewport.current = undefined;
      if (saved) void setViewport(saved, { duration: 260 });
      return;
    }
    if (phase !== "expanded" || last === "expanded") return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const node = getNode("project-git");
        if (!node) return;
        void fitView({
          nodes: [node],
          padding: 0.08,
          maxZoom: savedViewport.current?.zoom ?? getViewport().zoom,
          duration: 260,
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [fitView, getNode, getViewport, phase, setViewport]);

  return null;
}

function GithubViewportController({ expanded }: { expanded: boolean }) {
  const { fitView, getNode, getViewport, setViewport } = useReactFlow();
  const previous = React.useRef(false);
  const savedViewport = React.useRef<CanvasViewport | undefined>(undefined);

  React.useLayoutEffect(() => {
    const last = previous.current;
    previous.current = expanded;
    if (!last && expanded) {
      savedViewport.current = getViewport();
    }
    if (!expanded) {
      const saved = savedViewport.current;
      savedViewport.current = undefined;
      if (saved) void setViewport(saved, { duration: 260 });
      return;
    }
    if (last) return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const node = getNode("project-github");
        if (!node) return;
        void fitView({
          nodes: [node],
          padding: 0.08,
          maxZoom: savedViewport.current?.zoom ?? getViewport().zoom,
          duration: 260,
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [expanded, fitView, getNode, getViewport, setViewport]);

  return null;
}

function TokenUsageViewportController({ expanded }: { expanded: boolean }) {
  const { fitView, getNode, getViewport, setViewport } = useReactFlow();
  const previous = React.useRef(false);
  const savedViewport = React.useRef<CanvasViewport | undefined>(undefined);

  React.useLayoutEffect(() => {
    const last = previous.current;
    previous.current = expanded;
    if (!last && expanded) {
      savedViewport.current = getViewport();
    }
    if (!expanded) {
      const saved = savedViewport.current;
      savedViewport.current = undefined;
      if (saved) void setViewport(saved, { duration: 260 });
      return;
    }
    if (last) return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const node = getNode("token-usage");
        if (!node) return;
        void fitView({
          nodes: [node],
          padding: 0.08,
          maxZoom: savedViewport.current?.zoom ?? getViewport().zoom,
          duration: 260,
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [expanded, fitView, getNode, getViewport, setViewport]);

  return null;
}

function minimapNodeColor(node: Node<StartNodeData>): string {
  switch (node.data.kind) {
    case "requirement-chat":
      return "var(--accent-model)";
    case "project-terminal":
      return "var(--accent-projects)";
    case "project-git":
      return "var(--accent-warning)";
    case "project-settings":
      return "var(--accent-model)";
    case "requirement-list":
      return node.data.tone === "done"
        ? "var(--success)"
        : "var(--accent-warning)";
    case "requirement-dag":
      return "var(--color-info)";
    case "requirement-task":
      return "var(--accent-create)";
    case "token-usage":
      return "var(--success)";
    default:
      return "var(--text-soft)";
  }
}

export default function App() {
  useEffect(() => {
    if (window.location.pathname !== "/") {
      window.history.replaceState(
        null,
        "",
        `/${window.location.search}${window.location.hash}`,
      );
    }
  }, []);
  const current = useCurrentProject();
  const selectedProjectId = current.project?.id ?? null;
  const project = useProjectCanvas(selectedProjectId, current.setError);
  const requirement = useRequirementFlow(
    selectedProjectId,
    project.activeRequirementId,
    project.observedRequirementId,
    project.setProjectCanvas,
    project.loadProjectCanvas,
    project.setSelectedDagRequirementId,
  );
  const projectChat = useProjectChat(selectedProjectId);
  const models = useModelSettings(current.applyTheme, current.loadCurrent);
  const terminalHost = models.basicSettings?.effective_host;
  const terminalAccessRequired = terminalHost === "0.0.0.0";
  const terminalBlockedReason = useMemo(() => {
    if (terminalAccessRequired) return undefined;
    const hostname =
      typeof window !== "undefined" ? window.location.hostname : "localhost";
    if (hostname !== "localhost" && hostname !== "127.0.0.1") {
      return "non-localhost-access";
    }
    return undefined;
  }, [terminalAccessRequired]);
  const terminals = useProjectTerminals(
    selectedProjectId,
    terminalBlockedReason,
    terminalAccessRequired,
  );
  const git = useProjectGit(selectedProjectId);
  const [nodeDragging, setNodeDragging] = useState(false);
  const [githubExpanded, setGithubExpanded] = useState(false);
  const [tokenUsageExpanded, setTokenUsageExpanded] = useState(false);
  const modelSetupGuideStep: ModelSetupGuideStep | null =
    models.modelSetupGuideActive
      ? models.settingsExpanded
        ? "models"
        : "settings"
      : null;
  const requirementConversationEvents = project.selectedDagRequirementId
    ? EMPTY_STREAM_EVENTS
    : requirement.requirementStreamEvents;

  const projectStructureNodes = useMemo(
    () =>
      buildProjectNodes({
        projectCanvas: project.projectCanvas,
        project: current.project,
        publicationReadiness: current.publicationReadiness,
        selectedDagRequirement: project.selectedDagRequirement,
        selectedDagRequirementId: project.selectedDagRequirementId,
        collapsedTaskGroups: project.collapsedTaskGroups,
        requirementActionBusyId: project.requirementActionBusyId,
        recoveringTaskGroupIds: project.recoveringTaskGroupIds,
        requirementActionError: project.requirementActionError,
        githubExpanded,
        tokenUsageExpanded,
        closeDag: project.closeDag,
        selectDagRequirement: project.selectDagRequirement,
        planRequirement: project.planRequirement,
        recoverTaskGroup: project.recoverTaskGroup,
        toggleTaskGroupCollapsed: project.toggleTaskGroupCollapsed,
        onToggleGithubExpanded: () => setGithubExpanded((current) => !current),
        onToggleTokenUsageExpanded: () =>
          setTokenUsageExpanded((current) => !current),
      }),
    [
      current.project,
      current.publicationReadiness,
      githubExpanded,
      project.closeDag,
      project.collapsedTaskGroups,
      project.planRequirement,
      project.projectCanvas,
      project.recoveringTaskGroupIds,
      project.requirementActionBusyId,
      project.requirementActionError,
      project.recoverTaskGroup,
      project.selectDagRequirement,
      project.selectedDagRequirement,
      project.selectedDagRequirementId,
      project.toggleTaskGroupCollapsed,
      tokenUsageExpanded,
    ],
  );

  const projectChatNode = useMemo(
    () =>
      buildProjectChatNode({
        projectCanvas: project.projectCanvas,
        project: current.project,
        requirementConversation: requirement.requirementConversation,
        requirementInput: requirement.requirementInput,
        requirementReferences: requirement.requirementReferences,
        requirementImages: requirement.requirementImages,
        requirementBusy: requirement.requirementBusy,
        requirementError: requirement.requirementError,
        requirementStreamEvents: requirementConversationEvents,
        projectChat: projectChat.projectChat,
        projectChatInput: projectChat.projectChatInput,
        projectChatReferences: projectChat.projectChatReferences,
        projectChatImages: projectChat.projectChatImages,
        projectChatBusy: projectChat.projectChatBusy,
        projectChatError: projectChat.projectChatError,
        projectChatEvents: projectChat.projectChatEvents,
        clarificationAnswers: requirement.clarificationAnswers,
        dismissedPromptRequirementId: requirement.dismissedPromptRequirementId,
        setRequirementInput: requirement.setRequirementInput,
        setRequirementReferences: requirement.setRequirementReferences,
        setRequirementImages: requirement.setRequirementImages,
        sendRequirementMessage: requirement.sendRequirementMessage,
        setProjectChatInput: projectChat.setProjectChatInput,
        setProjectChatReferences: projectChat.setProjectChatReferences,
        setProjectChatImages: projectChat.setProjectChatImages,
        sendProjectChatMessage: projectChat.sendProjectChat,
        resetProjectChat: projectChat.closeProjectChat,
        updateClarificationAnswer: requirement.updateClarificationAnswer,
        submitClarifications: requirement.submitClarifications,
        confirmRequirement: requirement.confirmRequirement,
        retryRequirementAnalysis: requirement.retryRequirementAnalysis,
        continueEditingRequirement: requirement.continueEditingRequirement,
        cancelRequirementAnalysis: project.cancelRequirementAnalysis,
        abandonRequirement: project.abandonRequirement,
      }),
    [
      current.project,
      project.abandonRequirement,
      project.cancelRequirementAnalysis,
      project.projectCanvas,
      projectChat.closeProjectChat,
      projectChat.projectChat,
      projectChat.projectChatBusy,
      projectChat.projectChatError,
      projectChat.projectChatEvents,
      projectChat.projectChatImages,
      projectChat.projectChatInput,
      projectChat.projectChatReferences,
      projectChat.sendProjectChat,
      projectChat.setProjectChatImages,
      projectChat.setProjectChatInput,
      projectChat.setProjectChatReferences,
      requirement.clarificationAnswers,
      requirement.confirmRequirement,
      requirement.retryRequirementAnalysis,
      requirement.continueEditingRequirement,
      requirement.dismissedPromptRequirementId,
      requirement.requirementBusy,
      requirement.requirementConversation,
      requirement.requirementError,
      requirement.requirementImages,
      requirement.requirementInput,
      requirement.requirementReferences,
      requirementConversationEvents,
      requirement.sendRequirementMessage,
      requirement.setRequirementImages,
      requirement.setRequirementInput,
      requirement.setRequirementReferences,
      requirement.submitClarifications,
      requirement.updateClarificationAnswer,
    ],
  );

  const terminalDisabled = terminals.terminalDisabled;
  const terminalDisabledReason = terminals.terminalDisabledReason;

  const projectSettingsNode = useMemo(
    () =>
      buildProjectSettingsNode({
        projectCanvas: project.projectCanvas,
        project: current.project,
        expanded: models.settingsExpanded,
        page: models.settingsPage,
        basicSettings: models.basicSettings,
        basicError: models.basicSettingsError,
        savingBasic: models.savingBasicSettings,
        savingTheme: models.savingTheme,
        modelSettings: models.draftModelSettings,
        models: models.models,
        modelRpcStatus: models.modelRpcStatus,
        modelError: models.modelError,
        savingModels: models.savingModels,
        terminalDisabled,
        terminalAccessRequired: terminals.terminalAccessRequired,
        terminalAccessAuthorized: terminals.terminalAccessAuthorized,
        terminalAccessBusy: terminals.terminalAccessBusy,
        terminalAccessError: terminals.terminalAccessError,
        piLoginSession: terminals.piLoginSession,
        piLoginBusy: terminals.piLoginBusy,
        piLoginError: terminals.piLoginError,
        needsModelOnboarding: models.needsModelOnboarding,
        modelDraftComplete: models.modelDraftComplete,
        modelSavedComplete: models.modelSavedComplete,
        onToggleExpanded: () => {
          if (models.settingsExpanded) {
            void terminals.closePiLoginTerminal();
          }
          models.toggleSettings();
        },
        onOpenBasic: models.openBasicSettings,
        onOpenModels: models.openModelSettings,
        onBasicChange: models.updateBasicSettings,
        onThemeChange: models.changeTheme,
        onSaveBasic: models.saveBasicSettings,
        onModelChange: models.updateModelTier,
        onSaveModels: models.saveModelSettings,
        onReloadModels: models.reloadModelSettings,
        onAuthorizeTerminalAccess: terminals.authorizeTerminalAccess,
        onStartPiLogin: terminals.startPiLoginTerminal,
        onClosePiLogin: terminals.closePiLoginTerminal,
      }),
    [
      current.project,
      models.basicSettings,
      models.basicSettingsError,
      models.changeTheme,
      models.draftModelSettings,
      models.modelDraftComplete,
      models.modelError,
      models.modelRpcStatus,
      models.modelSavedComplete,
      models.models,
      models.needsModelOnboarding,
      models.openBasicSettings,
      models.openModelSettings,
      models.reloadModelSettings,
      models.saveBasicSettings,
      models.saveModelSettings,
      models.savingBasicSettings,
      models.savingModels,
      models.savingTheme,
      models.settingsExpanded,
      models.settingsPage,
      models.toggleSettings,
      models.updateBasicSettings,
      models.updateModelTier,
      project.projectCanvas,
      terminalDisabled,
      terminals.authorizeTerminalAccess,
      terminals.closePiLoginTerminal,
      terminals.terminalAccessAuthorized,
      terminals.terminalAccessBusy,
      terminals.terminalAccessError,
      terminals.terminalAccessRequired,
      terminals.piLoginBusy,
      terminals.piLoginError,
      terminals.piLoginSession,
      terminals.startPiLoginTerminal,
    ],
  );

  const projectTerminalNode = useMemo(
    () =>
      buildProjectTerminalNode({
        projectCanvas: project.projectCanvas,
        project: current.project,
        collapsed: terminals.collapsed,
        sessions: terminals.sessions,
        activeSessionId: terminals.activeSessionId,
        commandProfiles: terminals.commandProfiles,
        busy: terminals.busy,
        error: terminals.error,
        terminalDisabled,
        terminalDisabledReason,
        terminalAccessRequired: terminals.terminalAccessRequired,
        terminalAccessAuthorized: terminals.terminalAccessAuthorized,
        terminalAccessExpiresAt: terminals.terminalAccessExpiresAt,
        terminalAccessBusy: terminals.terminalAccessBusy,
        terminalAccessError: terminals.terminalAccessError,
        onToggleCollapsed: terminals.toggleCollapsed,
        onAuthorizeTerminalAccess: terminals.authorizeTerminalAccess,
        onCreateTerminal: terminals.createTerminal,
        onCloseTerminal: terminals.closeTerminal,
        onSelectTerminal: terminals.selectTerminal,
        onSaveCommandProfiles: terminals.saveCommandProfiles,
      }),
    [
      current.project,
      terminalDisabled,
      terminalDisabledReason,
      project.projectCanvas,
      terminals.activeSessionId,
      terminals.authorizeTerminalAccess,
      terminals.busy,
      terminals.closeTerminal,
      terminals.collapsed,
      terminals.commandProfiles,
      terminals.createTerminal,
      terminals.error,
      terminals.saveCommandProfiles,
      terminals.selectTerminal,
      terminals.sessions,
      terminals.terminalAccessAuthorized,
      terminals.terminalAccessBusy,
      terminals.terminalAccessError,
      terminals.terminalAccessExpiresAt,
      terminals.terminalAccessRequired,
      terminals.toggleCollapsed,
    ],
  );

  const projectGitNode = useMemo(
    () =>
      buildProjectGitNode({
        projectCanvas: project.projectCanvas,
        project: current.project,
        phase: git.phase,
        status: git.status,
        diff: git.diff,
        selectedPaths: git.selectedPaths,
        selectedDiff: git.selectedDiff,
        busy: git.busy,
        error: git.error,
        lastResult: git.lastResult,
        onToggleExpanded: git.toggleExpanded,
        onRefresh: git.load,
        onTogglePath: git.togglePath,
        onSelectDiff: git.selectDiff,
        onAction: git.action,
      }),
    [
      current.project,
      git.action,
      git.busy,
      git.diff,
      git.error,
      git.lastResult,
      git.load,
      git.phase,
      git.selectDiff,
      git.selectedDiff,
      git.selectedPaths,
      git.status,
      git.toggleExpanded,
      git.togglePath,
      project.projectCanvas,
    ],
  );

  const nodes = useMemo(
    () =>
      mergeProjectNodes(
        projectStructureNodes,
        projectSettingsNode,
        projectChatNode,
        projectTerminalNode,
        projectGitNode,
      ),
    [
      projectChatNode,
      projectGitNode,
      projectSettingsNode,
      projectStructureNodes,
      projectTerminalNode,
    ],
  );

  const edges = useMemo<Edge[]>(() => {
    const flowEdges: Edge[] = project.selectedDagRequirement
      ? []
      : [
          {
            id: "completed-requirements-to-requirement-chat",
            source: "completed-requirements",
            sourceHandle: "requirement-list-right",
            target: "requirement-chat",
            targetHandle: "requirement-chat-left",
            type: "smoothstep",
            animated: true,
            style: { stroke: "var(--edge-secondary)", strokeWidth: 2 },
          },
          {
            id: "requirement-chat-to-queued-requirements",
            source: "requirement-chat",
            sourceHandle: "requirement-chat-right",
            target: "queued-requirements",
            targetHandle: "requirement-list-left",
            type: "smoothstep",
            animated: true,
            style: { stroke: "var(--edge-model)", strokeWidth: 2 },
          },
        ];

    if (project.selectedDagRequirement) {
      flowEdges.push(
        ...buildRequirementDagEdges(
          project.selectedDagRequirement,
          project.collapsedTaskGroups,
        ),
      );
    }
    return flowEdges;
  }, [project.collapsedTaskGroups, project.selectedDagRequirement]);
  const requirementHomeNodes = nodes.filter((node) =>
    REQUIREMENT_HOME_NODE_IDS.has(node.id),
  );

  return (
    <main className="app-shell" data-theme={current.theme}>
      <section className="toolbar">
        <div className="toolbar__brand">
          <img
            className="app-logo"
            src="/raccoon-icon-180.png"
            alt=""
            width="36"
            height="36"
          />
          <div>
            <h1>Raccoon Node</h1>
            <p>
              {current.project
                ? `${current.project.name} / 项目画布`
                : "项目画布"}
            </p>
          </div>
        </div>
        <div className="status-pill">
          {current.error
            ? current.error
            : current.loading
              ? "加载中"
              : "已连接"}
        </div>
      </section>
      <section
        className={`canvas-shell${nodeDragging ? " canvas-shell--dragging" : ""}`}
      >
        <RequirementTaskEventsProvider
          requirementId={project.observedRequirementId}
          events={requirement.requirementStreamEvents}
        >
          <ReactFlowProvider>
            <ReactFlow
              key={getReactFlowKey({
                projectId: selectedProjectId,
                projectLoaded: Boolean(project.projectCanvas),
              })}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.08, duration: 0 }}
              minZoom={0.05}
              maxZoom={2}
              nodesDraggable
              onNodeDragStart={() => setNodeDragging(true)}
              onNodeDragStop={() => setNodeDragging(false)}
              nodesConnectable={false}
              elementsSelectable
              panOnScroll
              panActivationKeyCode="Space"
              selectionOnDrag
              defaultEdgeOptions={{
                type: "smoothstep",
                style: { strokeWidth: 2 },
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  width: 12,
                  height: 12,
                },
              }}
            >
              <Background color="var(--canvas-dot)" gap={32} size={1.5} />
              {project.selectedDagRequirement ? (
                <MiniMap
                  position="bottom-left"
                  pannable
                  zoomable
                  nodeColor={minimapNodeColor}
                  nodeStrokeWidth={2}
                  nodeStrokeColor="var(--card-border-strong)"
                />
              ) : null}
              <RequirementsReturnButton nodes={requirementHomeNodes} />
              {modelSetupGuideStep ? (
                <ModelSetupGuide
                  step={modelSetupGuideStep}
                  onSkip={models.skipModelSetupGuide}
                />
              ) : null}
              <Controls position="bottom-right" />
              <ProjectCanvasViewportController
                projectLoaded={Boolean(project.projectCanvas)}
                selectedDagRequirementId={project.selectedDagRequirementId}
              />
              <SettingsViewportController
                expanded={models.settingsExpanded}
                node={projectSettingsNode}
              />
              <TerminalViewportController collapsed={terminals.collapsed} />
              <GitViewportController phase={git.phase} />
              <GithubViewportController expanded={githubExpanded} />
              <TokenUsageViewportController expanded={tokenUsageExpanded} />
            </ReactFlow>
          </ReactFlowProvider>
        </RequirementTaskEventsProvider>
      </section>
    </main>
  );
}
