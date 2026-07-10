import {
  type Project,
  type ProjectCanvasData,
  type ModelSettings,
  type ModelSettingsResponse,
  type Requirement,
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
  type RequirementTaskDetail,
  type SessionTranscriptPage,
  type ProjectFileContent,
  type ProjectFileTreeEntry,
  type PublicationReadiness,
  type TerminalAccessStatus,
  type TerminalCommandProfile,
  type TerminalCommandProfileDraft,
  type TerminalSession,
  type GitAction,
  type GitDiff,
  type GitDiffArea,
  type GitStatus,
  type ThemePack,
  type ChatAccepted,
  type RequirementAccepted,
  type AcceptedOperation,
} from "../types/api";

export async function getCurrentProject(): Promise<{
  project: Project;
  theme_pack: ThemePack;
  theme_mode: ThemeMode;
  publication_readiness: PublicationReadiness;
}> {
  const response = await fetch("/api/project/current");
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
  projectId: string,
  dagRequirementId?: string | null,
): Promise<ProjectCanvasData> {
  const query = dagRequirementId
    ? `?dag_requirement_id=${encodeURIComponent(dagRequirementId)}`
    : "";
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/canvas${query}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取项目画布失败");
  }
  return response.json();
}

export async function getRequirementTask(
  requirementId: string,
  taskId: string,
): Promise<RequirementTaskDetail> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/tasks/${encodeURIComponent(taskId)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取任务详情失败");
  }
  return response.json();
}

export async function getTaskSession(
  requirementId: string,
  taskId: string,
  before?: number | null,
): Promise<SessionTranscriptPage> {
  const query = before == null ? "" : `?before=${before}`;
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/tasks/${encodeURIComponent(taskId)}/session${query}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取任务会话失败");
  }
  return response.json();
}

export async function getRequirementSession(
  requirementId: string,
  before?: number | null,
): Promise<SessionTranscriptPage> {
  const query = before == null ? "" : `?before=${before}`;
  return sessionResponse(
    await fetch(
      `/api/requirements/${encodeURIComponent(requirementId)}/session${query}`,
    ),
  );
}

export async function getProjectChatSession(
  projectId: string,
  before?: number | null,
): Promise<SessionTranscriptPage> {
  const query = before == null ? "" : `?before=${before}`;
  return sessionResponse(
    await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/chat/session${query}`,
    ),
  );
}

async function sessionResponse(
  response: Response,
): Promise<SessionTranscriptPage> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取会话记录失败");
  }
  return response.json();
}

export async function getProjectTerminals(
  projectId: string,
): Promise<TerminalSession[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/terminals`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取项目终端失败");
  }
  return response.json();
}

export async function getTerminalAccessStatus(
  projectId: string,
): Promise<TerminalAccessStatus> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/terminal-access`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取终端授权状态失败");
  }
  return response.json();
}

export async function unlockTerminalAccess(
  projectId: string,
  key: string,
): Promise<TerminalAccessStatus> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/terminal-access`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    },
  );
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

export async function getProjectGitStatus(
  projectId: string,
): Promise<GitStatus> {
  return gitResponse(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/git/status`),
    "读取 Git 状态失败",
  );
}

export async function getProjectGitDiff(
  projectId: string,
  path: string,
  area: GitDiffArea,
): Promise<GitDiff> {
  const query = new URLSearchParams({ path, area });
  return gitResponse(
    await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/git/diff?${query}`,
    ),
    "读取文件差异失败",
  );
}

export async function executeProjectGitAction(
  projectId: string,
  action: GitAction,
): Promise<GitStatus> {
  return gitResponse(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/git/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    }),
    "Git 操作失败",
  );
}

export async function createProjectTerminal(
  projectId: string,
  payload: { command?: string | null; title?: string | null },
): Promise<TerminalSession> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/terminals`,
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
    throw new Error(body?.message ?? "启动项目终端失败");
  }
  return response.json();
}

export async function deleteProjectTerminal(
  projectId: string,
  terminalId: string,
): Promise<TerminalSession[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}`,
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

export async function getTerminalCommandProfiles(
  projectId: string,
): Promise<TerminalCommandProfile[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/terminal-commands`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取终端启动命令失败");
  }
  return response.json();
}

export async function putTerminalCommandProfiles(
  projectId: string,
  profiles: TerminalCommandProfileDraft[],
): Promise<TerminalCommandProfile[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/terminal-commands`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profiles }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "保存终端启动命令失败");
  }
  return response.json();
}

export function terminalWebSocketUrl(projectId: string, terminalId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}/ws`;
}

function webSocketUrl(path: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

export function projectChatWebSocketUrl(projectId: string) {
  return webSocketUrl(
    `/api/projects/${encodeURIComponent(projectId)}/chat/events`,
  );
}

export function requirementConversationWebSocketUrl(requirementId: string) {
  return webSocketUrl(
    `/api/requirements/${encodeURIComponent(requirementId)}/conversation/events`,
  );
}

export async function getProjectChat(
  projectId: string,
): Promise<ProjectChatResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/chat`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取项目问答失败");
  }
  return response.json();
}

export async function resetProjectChat(
  projectId: string,
): Promise<ProjectChatResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/chat`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "关闭项目问答失败");
  }
  return response.json();
}

export async function getProjectFiles(
  projectId: string,
  search: string,
  signal?: AbortSignal,
): Promise<FileReference[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files?search=${encodeURIComponent(search)}`,
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
  projectId: string,
  path: string,
): Promise<ProjectFileContent> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(path)}`,
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
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<ProjectFileTreeEntry[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files/tree?path=${encodeURIComponent(path)}`,
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
  projectId: string,
  file: File,
): Promise<ImageAttachment> {
  const dataBase64 = await readFileAsDataUrl(file);
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/attachments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name || "image",
        mime_type: file.type,
        data_base64: dataBase64,
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "上传图片失败");
  }
  return response.json();
}

export async function sendProjectChatMessage(
  projectId: string,
  payload: {
    message: string;
    references: FileReference[];
    images: ImageAttachment[];
  },
): Promise<ChatAccepted> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/chat/messages`,
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
    throw new Error(body?.message ?? "发送项目问答失败");
  }
  return response.json();
}

export async function abortProjectChat(
  projectId: string,
): Promise<AcceptedOperation> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/chat/abort`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "停止项目问答失败");
  }
  return response.json();
}

export async function createRequirement(
  projectId: string,
  payload: {
    message: string;
    references: FileReference[];
    images: ImageAttachment[];
  },
): Promise<RequirementAccepted> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/requirements`,
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

export async function createRequirementBranch(
  projectId: string,
  payload: {
    message: string;
    references: FileReference[];
    images: ImageAttachment[];
  },
): Promise<RequirementAccepted> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/chat/commands/requirement-branch`,
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
  prompt?: { prompt_id?: string; revision?: number },
): Promise<ProjectCanvasData> {
  const body =
    prompt?.prompt_id || prompt?.revision
      ? { prompt_id: prompt.prompt_id, revision: prompt.revision, answers }
      : answers;
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/clarifications`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  prompt?: { prompt_id?: string; revision?: number },
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/confirm`,
    {
      method: "POST",
      headers: prompt ? { "Content-Type": "application/json" } : undefined,
      body: prompt ? JSON.stringify(prompt) : undefined,
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

export async function planRequirementExecution(
  requirementId: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/plan`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "生成执行 DAG 失败");
  }
  return response.json();
}

export async function recoverTaskGroup(
  requirementId: string,
  taskId: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/tasks/${encodeURIComponent(taskId)}/recover`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "恢复任务失败");
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
