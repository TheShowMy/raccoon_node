import React, { Suspense, useEffect, useMemo, useState } from "react";
import {
  Background,
  MarkerType,
  type Node,
  type NodeProps,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useStore,
  useViewport,
} from "@xyflow/react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Theme } from "@astryxdesign/core/theme";
import {
  Card,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Text,
  VStack,
} from "@astryxdesign/core";
import { X } from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./styles/index.css";

import type { StartNodeData, StreamEvent } from "./types/api";
import ChatCanvasNode from "./canvas/ChatCanvasNode";
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
import {
  buildOrbitNodes,
  OrbitNode,
  type MainPanelKind,
} from "./canvas/orbitNodes";
import {
  MAIN_CANVAS_INTERACTION_PROPS,
  useMainCanvasViewport,
} from "./canvas/mainCanvasViewport";

const FilesWorkbench = React.lazy(
  () => import("./components/workbenches/FilesWorkbench"),
);
const RequirementsWorkbench = React.lazy(
  () => import("./components/workbenches/RequirementsWorkbench"),
);
const SettingsWorkbench = React.lazy(
  () => import("./components/workbenches/SettingsWorkbench"),
);
const TerminalWorkbench = React.lazy(
  () => import("./components/workbenches/TerminalWorkbench"),
);
const GitWorkbench = React.lazy(
  () => import("./components/workbenches/GitWorkbench"),
);
const TokenWorkbench = React.lazy(
  () => import("./components/workbenches/TokenWorkbench"),
);

const nodeTypes = {
  chatNode: ChatCanvasNode,
  orbitNode: OrbitNode,
  workspacePanel: WorkspacePanel,
};
const EMPTY_STREAM_EVENTS: StreamEvent[] = [];

type WorkspacePanelData = Record<string, unknown> & {
  title: string;
  content: React.ReactNode;
  onClose: () => void;
};

function WorkspacePanel({ data }: NodeProps<Node<WorkspacePanelData>>) {
  return (
    <Card
      width="100%"
      height="100%"
      padding={0}
      className="workspace-panel nodrag"
    >
      <Layout
        height="fill"
        padding={0}
        header={
          <LayoutHeader hasDivider padding={2}>
            <HStack align="center" justify="between">
              <Heading level={2}>{data.title}</Heading>
              <Button
                label="关闭面板"
                tooltip="关闭面板"
                isIconOnly
                variant="ghost"
                icon={<X size={16} />}
                onClick={data.onClose}
              />
            </HStack>
          </LayoutHeader>
        }
      >
        <LayoutContent padding={0} isScrollable>
          <Suspense fallback={<Spinner label="正在加载工作台" />}>
            {data.content}
          </Suspense>
        </LayoutContent>
      </Layout>
    </Card>
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
      <Card
        className="model-setup-guide__card"
        role="dialog"
        aria-label="模型配置新手引导"
        padding={3}
      >
        <VStack gap={2}>
          <Text type="supporting">
            第 {step === "settings" ? "1" : "2"}/2 步
          </Text>
          <Text weight="bold">
            {step === "settings"
              ? "点击左上角的「设置」节点"
              : "点击设置工作台中的「模型设置」"}
          </Text>
          <Text color="secondary">
            {step === "settings"
              ? "从设置工作台开始配置 Pi 模型。"
              : "进入后按页面提示登录 Pi 并配置低、中、高三档模型。"}
          </Text>
          <Button
            label="跳过引导"
            className="model-setup-guide__action"
            variant="secondary"
            size="sm"
            onClick={onSkip}
          />
        </VStack>
      </Card>
    </Panel>
  );
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
  const [tokenUsageExpanded, setTokenUsageExpanded] = useState(false);
  const [openPanel, setOpenPanel] = useState<MainPanelKind | null>(null);
  const mainCanvasViewport = useMainCanvasViewport({ openPanel });
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
        selectedDagRequirement: project.selectedDagRequirement,
        selectedDagRequirementId: project.selectedDagRequirementId,
        collapsedTaskGroups: project.collapsedTaskGroups,
        requirementActionBusyId: project.requirementActionBusyId,
        recoveringTaskGroupIds: project.recoveringTaskGroupIds,
        requirementActionError: project.requirementActionError,
        tokenUsageExpanded,
        closeDag: project.closeDag,
        selectDagRequirement: project.selectDagRequirement,
        planRequirement: project.planRequirement,
        recoverTaskGroup: project.recoverTaskGroup,
        toggleTaskGroupCollapsed: project.toggleTaskGroupCollapsed,
        onToggleTokenUsageExpanded: () =>
          setTokenUsageExpanded((current) => !current),
      }),
    [
      current.project,
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
        abortProjectChat: projectChat.abortProjectChat,
        generateProjectRequirementSummary:
          projectChat.generateRequirementSummary,
        resetProjectChat: projectChat.closeProjectChat,
        retryRequirementSummarySync: projectChat.retryRequirementSummarySync,
        openRequirement: (requirementId) => {
          const requirement = [
            ...(project.projectCanvas?.active_requirement
              ? [project.projectCanvas.active_requirement]
              : []),
            ...(project.projectCanvas?.queued_requirements ?? []),
            ...(project.projectCanvas?.completed_requirements ?? []),
          ].find((candidate) => candidate.id === requirementId);
          if (requirement) project.selectDagRequirement(requirement);
          setOpenPanel("requirements");
        },
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
      projectChat.abortProjectChat,
      projectChat.generateRequirementSummary,
      projectChat.projectChat,
      projectChat.projectChatBusy,
      projectChat.projectChatError,
      projectChat.projectChatEvents,
      projectChat.projectChatImages,
      projectChat.projectChatInput,
      projectChat.projectChatReferences,
      projectChat.retryRequirementSummarySync,
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
      project.selectDagRequirement,
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

  const requirementNodes = useMemo(
    () =>
      projectStructureNodes
        .filter((node) => node.id !== "token-usage")
        .map((node) => ({
          ...node,
          position: {
            x: node.id === "requirements" ? 0 : node.position.x - 960,
            y: node.id === "requirements" ? 20 : node.position.y,
          },
        })),
    [projectStructureNodes],
  );
  const requirementEdges = useMemo(
    () =>
      project.selectedDagRequirement
        ? buildRequirementDagEdges(
            project.selectedDagRequirement,
            project.collapsedTaskGroups,
          )
        : [],
    [project.collapsedTaskGroups, project.selectedDagRequirement],
  );

  const closePanel = () => {
    if (openPanel === "settings") void terminals.closePiLoginTerminal();
    setOpenPanel(null);
  };

  const panelContent = useMemo(() => {
    if (!openPanel || !current.project) return null;
    if (openPanel === "files") {
      return <FilesWorkbench projectId={current.project.id} />;
    }
    if (openPanel === "requirements") {
      return (
        <RequirementsWorkbench
          nodes={requirementNodes}
          edges={requirementEdges}
        />
      );
    }
    if (openPanel === "settings" && projectSettingsNode) {
      return (
        <SettingsWorkbench
          data={
            {
              ...projectSettingsNode.data,
              expanded: true,
              onToggleExpanded: closePanel,
            } as Extract<StartNodeData, { kind: "project-settings" }>
          }
        />
      );
    }
    if (openPanel === "terminal" && projectTerminalNode) {
      return (
        <TerminalWorkbench
          data={
            {
              ...projectTerminalNode.data,
              collapsed: false,
              onToggleCollapsed: closePanel,
            } as Extract<StartNodeData, { kind: "project-terminal" }>
          }
        />
      );
    }
    if (openPanel === "git" && projectGitNode) {
      return (
        <GitWorkbench
          data={
            {
              ...projectGitNode.data,
              phase: "expanded",
              onToggleExpanded: closePanel,
            } as Extract<StartNodeData, { kind: "project-git" }>
          }
        />
      );
    }
    if (openPanel === "tokens") {
      const tokenNode = projectStructureNodes.find(
        (node) => node.id === "token-usage",
      );
      if (tokenNode) {
        return (
          <TokenWorkbench
            data={
              {
                ...tokenNode.data,
                expanded: true,
                onToggleExpanded: closePanel,
              } as Extract<StartNodeData, { kind: "token-usage" }>
            }
          />
        );
      }
    }
    return null;
  }, [
    current.project,
    openPanel,
    projectGitNode,
    projectSettingsNode,
    projectStructureNodes,
    projectTerminalNode,
    requirementEdges,
    requirementNodes,
    terminals.closePiLoginTerminal,
  ]);

  const panelTitle: Record<MainPanelKind, string> = {
    settings: "设置工作台",
    terminal: "终端工作台",
    git: "Git 工作台",
    tokens: "Token 用量",
    requirements: "需求与执行 DAG",
    files: "文件浏览器",
  };

  const nodes = useMemo<Node[]>(() => {
    if (!projectChatNode || !current.project) return [];
    const requirements = project.projectCanvas
      ? [
          ...(project.projectCanvas.active_requirement
            ? [project.projectCanvas.active_requirement]
            : []),
          ...project.projectCanvas.queued_requirements,
          ...project.projectCanvas.completed_requirements,
        ]
      : [];
    const orbit = buildOrbitNodes({
      activePanel: openPanel,
      gitBranch: git.status?.branch ?? null,
      modelRpcStatus: models.modelRpcStatus,
      requirementCount: requirements.length,
      terminalCount: terminals.sessions.length,
      tokenContextPercent:
        project.projectCanvas?.token_usage?.context_percent ?? 0,
      onOpen: setOpenPanel,
    });
    const main: Node[] = [
      {
        ...projectChatNode,
        type: "chatNode",
        position: { x: 0, y: 0 },
        style: { width: 960, height: 760, pointerEvents: "all" },
        draggable: false,
      },
      ...orbit,
    ];
    if (openPanel && panelContent) {
      main.push({
        id: `panel-${openPanel}`,
        type: "workspacePanel",
        position: { x: 1540, y: 0 },
        style: {
          width: 1380,
          height: 840,
          pointerEvents: "all",
        },
        data: {
          title: panelTitle[openPanel],
          content: panelContent,
          onClose: closePanel,
        },
        draggable: false,
      });
    }
    return main;
  }, [
    current.project,
    git.status?.branch,
    models.modelRpcStatus,
    openPanel,
    panelContent,
    project.projectCanvas,
    projectChatNode,
    terminals.sessions.length,
  ]);

  const statusBadge = current.error
    ? { label: current.error, variant: "error" as const }
    : current.loading
      ? { label: "加载中", variant: "warning" as const }
      : { label: "已连接", variant: "success" as const };

  return (
    <Theme theme={current.theme} mode={current.themeMode}>
      <AppShell
        height="fill"
        contentPadding={0}
        variant="section"
        topNav={
          <TopNav
            label="Raccoon Node"
            heading={
              <TopNavHeading
                logo={
                  <img
                    src="/raccoon-icon-180.png"
                    alt=""
                    width={28}
                    height={28}
                  />
                }
                heading="Raccoon Node"
                subheading={
                  current.project
                    ? `${current.project.name} / 项目画布`
                    : "项目画布"
                }
              />
            }
            endContent={
              <Badge label={statusBadge.label} variant={statusBadge.variant} />
            }
          />
        }
      >
        <section
          ref={mainCanvasViewport.containerRef}
          className="canvas-shell"
          onPointerMove={mainCanvasViewport.onPointerMove}
          onPointerDownCapture={mainCanvasViewport.onPointerDownCapture}
          onPointerUpCapture={mainCanvasViewport.onPointerUpCapture}
          onPointerCancel={mainCanvasViewport.onPointerCancel}
        >
          <RequirementTaskEventsProvider
            requirementId={project.observedRequirementId}
            events={requirement.requirementStreamEvents}
          >
            <ReactFlowProvider>
              <ReactFlow
                className="main-project-flow"
                key={getReactFlowKey({
                  projectId: selectedProjectId,
                  projectLoaded: Boolean(project.projectCanvas),
                })}
                nodes={nodes}
                edges={[]}
                nodeTypes={nodeTypes}
                minZoom={0.05}
                maxZoom={2}
                onlyRenderVisibleElements={false}
                {...MAIN_CANVAS_INTERACTION_PROPS}
                onInit={mainCanvasViewport.onInit}
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
                <Background
                  color="var(--color-border-subtle)"
                  gap={32}
                  size={1.5}
                />
                {modelSetupGuideStep ? (
                  <ModelSetupGuide
                    step={modelSetupGuideStep}
                    onSkip={models.skipModelSetupGuide}
                  />
                ) : null}
              </ReactFlow>
            </ReactFlowProvider>
          </RequirementTaskEventsProvider>
        </section>
      </AppShell>
    </Theme>
  );
}
