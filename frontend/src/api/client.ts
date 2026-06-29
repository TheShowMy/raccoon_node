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
} from "../types/api";

export async function getCurrentProject(): Promise<{
  project: Project;
  theme: ThemeMode;
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
    theme: unknown;
  };
  if (current.theme !== "dark" && current.theme !== "light") {
    throw new Error("后端返回了无效主题");
  }
  return { project: current.project, theme: current.theme };
}

export async function getProjectCanvas(
  projectId: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/canvas`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取项目画布失败");
  }
  return response.json();
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
): Promise<FileReference[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files?search=${encodeURIComponent(search)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "读取项目文件失败");
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
): Promise<ProjectChatResponse> {
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

export async function createRequirement(
  projectId: string,
  payload: {
    message: string;
    references: FileReference[];
    images: ImageAttachment[];
  },
): Promise<ProjectCanvasData> {
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

export async function appendRequirementMessage(
  requirementId: string,
  payload: {
    message: string;
    references: FileReference[];
    images: ImageAttachment[];
  },
): Promise<ProjectCanvasData> {
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
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/clarifications`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answers),
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

export async function confirmRequirement(
  requirementId: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/confirm`,
    { method: "POST" },
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

export function retryFailedNode(
  requirementId: string,
  taskId: string,
): Promise<ProjectCanvasData> {
  return postTaskAction(requirementId, taskId, "retry", "重试失败节点失败");
}

export function retryFromNode(
  requirementId: string,
  taskId: string,
): Promise<ProjectCanvasData> {
  return postTaskAction(requirementId, taskId, "retry-from", "从节点恢复失败");
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

export function rerunReview(
  requirementId: string,
  taskId: string,
): Promise<ProjectCanvasData> {
  return postTaskAction(requirementId, taskId, "rerun-review", "重跑审核失败");
}

async function postTaskAction(
  requirementId: string,
  taskId: string,
  action: string,
  fallbackMessage: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? fallbackMessage);
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
  settings: Pick<BasicSettings, "theme" | "port">,
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
