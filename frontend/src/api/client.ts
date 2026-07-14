import {
  type Project,
  type ProjectCanvasData,
  type ModelSettings,
  type ModelSettingsResponse,
  type RequirementConversation,
  type DraftClarificationAnswer,
  type RequirementClarification,
  type ProjectChatResponse,
  type FileReference,
  type ImageAttachment,
  type ThemeMode,
  type BasicSettings,
  type BasicSettingsUpdate,
  type RestartResponse,
  type ProjectFileContent,
  type ProjectFileTreeEntry,
  type PublicationReadiness,
  type TerminalAccessStatus,
  type TerminalCommandProfile,
  type TerminalSession,
  type GitAction,
  type GitDiff,
  type GitDiffArea,
  type GitStatus,
  type ThemePack,
  type ChatAccepted,
  type RequirementAccepted,
  type AcceptedOperation,
  type WorkflowSnapshot,
  type WorkflowEventPage,
} from "../types/api";

export async function getCurrentProject(): Promise<{
  project: Project;
  theme_pack: ThemePack;
  theme_mode: ThemeMode;
  publication_readiness: PublicationReadiness;
}> {
  const response = await fetch("/api/project");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取当前项目失败");
  }
  const current = (await response.json()) as {
    project: Project;
    theme_pack: unknown;
    theme_mode: unknown;
    publication_readiness: PublicationReadiness;
  };
  if (!isThemePack(current.theme_pack)) {
    throw new Error("后端返回了无效主题包");
  }
  if (current.theme_mode !== "dark" && current.theme_mode !== "light") {
    throw new Error("后端返回了无效明暗模式");
  }
  return {
    project: current.project,
    theme_pack: current.theme_pack,
    theme_mode: current.theme_mode,
    publication_readiness: current.publication_readiness,
  };
}

function isThemePack(value: unknown): value is ThemePack {
  return [
    "neutral",
    "stone",
    "matcha",
    "y2k",
    "chocolate",
    "gothic",
    "butter",
  ].includes(String(value));
}

export async function getProjectCanvas(
  workflowRequirementId?: string | null,
): Promise<ProjectCanvasData> {
  const query = workflowRequirementId
    ? `?workflow_requirement_id=${encodeURIComponent(workflowRequirementId)}`
    : "";
  const response = await fetch(`/api/canvas${query}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取项目画布失败");
  }
  return response.json();
}

export async function getWorkflowEvents(
  runId: string,
  after = 0,
  limit = 100,
): Promise<WorkflowEventPage> {
  const response = await fetch(
    `/api/workflow-runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${limit}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取 WorkflowRun 时间线失败");
  }
  return response.json();
}

export async function resumeWorkflowRun(
  runId: string,
): Promise<WorkflowSnapshot> {
  const response = await fetch(
    `/api/workflow-runs/${encodeURIComponent(runId)}/resume`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "恢复 WorkflowRun 失败");
  }
  return response.json();
}

export async function restartWorkflowRunClean(
  runId: string,
): Promise<WorkflowSnapshot> {
  const response = await fetch(
    `/api/workflow-runs/${encodeURIComponent(runId)}/restart-clean`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "从干净工作区重新执行失败");
  }
  return response.json();
}

export async function getProjectTerminals(): Promise<TerminalSession[]> {
  const response = await fetch("/api/terminals");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取项目终端失败");
  }
  return response.json();
}

export async function getTerminalAccessStatus(): Promise<TerminalAccessStatus> {
  const response = await fetch("/api/terminal-access");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取终端授权状态失败");
  }
  return response.json();
}

export async function unlockTerminalAccess(
  key: string,
): Promise<TerminalAccessStatus> {
  const response = await fetch("/api/terminal-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "终端密钥验证失败");
  }
  return response.json();
}

async function gitResponse<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? fallback);
  }
  return response.json();
}

export async function getProjectGitStatus(): Promise<GitStatus> {
  return gitResponse(await fetch("/api/git/status"), "读取 Git 状态失败");
}

export async function getProjectGitDiff(
  path: string,
  area: GitDiffArea,
): Promise<GitDiff> {
  const query = new URLSearchParams({ path, area });
  return gitResponse(await fetch(`/api/git/diff?${query}`), "读取文件差异失败");
}

export async function executeProjectGitAction(
  action: GitAction,
): Promise<GitStatus> {
  return gitResponse(
    await fetch("/api/git/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    }),
    "Git 操作失败",
  );
}

export async function createProjectTerminal(payload: {
  command?: string | null;
  title?: string | null;
}): Promise<TerminalSession> {
  const response = await fetch("/api/terminals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "启动项目终端失败");
  }
  return response.json();
}

export async function deleteProjectTerminal(
  terminalId: string,
): Promise<TerminalSession[]> {
  const response = await fetch(
    `/api/terminals/${encodeURIComponent(terminalId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "关闭项目终端失败");
  }
  return response.json();
}

export async function getTerminalCommandProfiles(): Promise<
  TerminalCommandProfile[]
> {
  const response = await fetch("/api/terminal-commands");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取终端启动命令失败");
  }
  return response.json();
}

export function terminalWebSocketUrl(terminalId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/terminals/${encodeURIComponent(terminalId)}/ws`;
}

function webSocketUrl(path: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

export function projectChatWebSocketUrl() {
  return webSocketUrl("/api/chat/events");
}

export function requirementConversationWebSocketUrl(requirementId: string) {
  return webSocketUrl(
    `/api/requirements/${encodeURIComponent(requirementId)}/conversation/events`,
  );
}

export async function getProjectChat(): Promise<ProjectChatResponse> {
  const response = await fetch("/api/chat");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取项目问答失败");
  }
  return response.json();
}

export async function resetProjectChat(): Promise<ProjectChatResponse> {
  const response = await fetch("/api/chat", { method: "DELETE" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "关闭项目问答失败");
  }
  return response.json();
}

export async function getProjectFiles(
  search: string,
  signal?: AbortSignal,
): Promise<FileReference[]> {
  const response = await fetch(
    `/api/files?search=${encodeURIComponent(search)}`,
    { signal },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取项目文件失败");
  }
  return response.json();
}

export async function getProjectFileContent(
  path: string,
): Promise<ProjectFileContent> {
  const response = await fetch(
    `/api/files/content?path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取文件失败");
  }
  return response.json();
}

export async function getProjectFileTree(
  path: string,
  signal?: AbortSignal,
): Promise<ProjectFileTreeEntry[]> {
  const response = await fetch(
    `/api/files/tree?path=${encodeURIComponent(path)}`,
    { signal },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取文件树失败");
  }
  return response.json();
}

export async function uploadProjectAttachment(
  file: File,
): Promise<ImageAttachment> {
  const dataBase64 = await readFileAsDataUrl(file);
  const response = await fetch("/api/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name || "image",
      mime_type: file.type,
      data_base64: dataBase64,
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "上传图片失败");
  }
  return response.json();
}

export async function sendProjectChatMessage(payload: {
  message: string;
  references: FileReference[];
  images: ImageAttachment[];
}): Promise<ChatAccepted> {
  const response = await fetch("/api/chat/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "发送项目问答失败");
  }
  return response.json();
}

export async function abortProjectChat(): Promise<AcceptedOperation> {
  const response = await fetch("/api/chat/abort", { method: "POST" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "停止项目问答失败");
  }
  return response.json();
}

export async function createRequirementBranch(payload: {
  message: string;
  references: FileReference[];
  images: ImageAttachment[];
}): Promise<RequirementAccepted> {
  const response = await fetch("/api/chat/requirements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "创建需求分支失败");
  }
  return response.json();
}

export async function appendRequirementMessage(
  requirementId: string,
  payload: {
    message: string;
    references: FileReference[];
    images: ImageAttachment[];
  },
): Promise<RequirementAccepted> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "提交需求失败");
  }
  return response.json();
}

export async function getRequirementConversation(
  requirementId: string,
): Promise<RequirementConversation> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/conversation`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取需求会话失败");
  }
  return response.json();
}

export async function submitRequirementClarifications(
  requirementId: string,
  answers: ReturnType<typeof buildClarificationAnswerPayload>[],
  prompt: { prompt_id: string; revision: number },
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/clarifications`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt_id: prompt.prompt_id,
        revision: prompt.revision,
        answers,
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "提交澄清答案失败");
  }
  return response.json();
}

export async function retryRequirementAnalysis(
  requirementId: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/retry-analysis`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "重新分析需求失败");
  }
  return response.json();
}

export async function confirmRequirement(
  requirementId: string,
  prompt: { prompt_id: string; revision: number },
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prompt),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "确认需求失败");
  }
  return response.json();
}

export async function startRequirementWorkflow(
  requirementId: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/workflow-run`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "生成 WorkPlan 失败");
  }
  return response.json();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export async function cancelRequirementAnalysis(
  requirementId: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "取消失败");
  }
  return response.json();
}

export async function deleteRequirement(
  requirementId: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "删除需求失败");
  }
  return response.json();
}

export async function getModelSettings(): Promise<ModelSettingsResponse> {
  const response = await fetch("/api/settings/models");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取模型设置失败");
  }
  return response.json();
}

export async function getBasicSettings(): Promise<BasicSettings> {
  const response = await fetch("/api/settings/basic");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取基础设置失败");
  }
  return response.json();
}

export async function saveBasicSettings(
  settings: BasicSettingsUpdate,
): Promise<BasicSettings> {
  const response = await fetch("/api/settings/basic", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "保存基础设置失败");
  }
  return response.json();
}

export async function saveModelSettings(
  settings: ModelSettings,
): Promise<ModelSettingsResponse> {
  const response = await fetch("/api/settings/models", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "保存模型设置失败");
  }
  return response.json();
}

export async function reloadModelSettings(): Promise<ModelSettingsResponse> {
  const response = await fetch("/api/settings/models/reload", {
    method: "POST",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "重载 Pi 模型失败");
  }
  return response.json();
}

export async function restartApplication(): Promise<RestartResponse> {
  const response = await fetch("/api/system/restart", { method: "POST" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "重启应用失败");
  }
  return response.json();
}

export function buildClarificationAnswerPayload(
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
