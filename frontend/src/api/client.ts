import {
  type Project,
  type ProjectCanvasData,
  type ModelSettings,
  type ModelSettingsResponse,
  type Requirement,
  type DraftClarificationAnswer,
  type RequirementClarification,
} from "../types/api";

export async function fetchStart(): Promise<{
  projects: Project[];
  settings_summary: { title: string; description: string };
  model_summary: { title: string; description: string };
  model_settings: ModelSettings;
}> {
  const response = await fetch("/api/start");
  if (!response.ok) {
    throw new Error("读取 start 数据失败");
  }
  return response.json();
}

export async function createProject(
  name: string,
  gitUrl: string,
): Promise<void> {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, git_url: gitUrl }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "创建项目失败");
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? "删除项目失败");
  }
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

export async function createRequirement(
  projectId: string,
  message: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/requirements`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
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
  message: string,
): Promise<ProjectCanvasData> {
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
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
