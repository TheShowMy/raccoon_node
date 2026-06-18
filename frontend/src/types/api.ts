export type ThemeMode = "dark" | "light";

export type Project = {
  id: string;
  name: string;
  git_url: string;
  local_path: string;
  created_at: string;
  updated_at: string;
};

export type SummaryNode = {
  title: string;
  description: string;
};

export type StartData = {
  projects: Project[];
  settings_summary: SummaryNode;
  model_summary: SummaryNode;
  model_settings: ModelSettings;
};

export type RequirementStatus =
  | "analyzing"
  | "clarifying"
  | "draft_ready"
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type RequirementMessage = {
  role: "user" | "assistant" | "system" | "trace";
  content: string;
  metadata?: TraceMetadata | null;
  created_at: string;
};

export type RequirementDraft = {
  title: string;
  summary: string;
  acceptance_criteria: string[];
};

export type Requirement = {
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

export type ProjectCanvasData = {
  project: Project;
  active_requirement: Requirement | null;
  queued_requirements: Requirement[];
  completed_requirements: Requirement[];
};

export type ClarificationQuestionType =
  | "single_choice"
  | "multi_choice"
  | "free_text";

export type ClarificationOption = {
  value: string;
  label: string;
  description: string;
  recommended: boolean;
};

export type ClarificationAnswer = {
  selected_options: string[];
  custom_text: string | null;
};

export type RequirementClarification = {
  id: string;
  question: string;
  question_type: ClarificationQuestionType;
  options: ClarificationOption[];
  answer: ClarificationAnswer | null;
};

export type DraftClarificationAnswer = {
  selectedOptions: string[];
  customText: string;
};

export type StreamEvent = {
  requirement_id: string;
  event: string;
  message: string;
  pi_type?: string;
  payload?: unknown;
};

export type TraceTool = {
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error" | string;
  output: string;
  isError?: boolean;
};

export type TraceData = {
  thinking: string;
  output: string;
  tools: TraceTool[];
  statuses: Array<{ type: string; message: string }>;
};

export type TraceMetadata = {
  type: "pi_trace";
  version: number;
  trace: TraceData;
};

export type LiveBubble = {
  id: string;
  type: "thinking" | "tool" | "output" | "status";
  label: string;
  content: string;
  toolName?: string;
  status: "running" | "done" | "error";
};

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type ModelTierKey = "low" | "medium" | "high";

export type ModelTierSetting = {
  model_id: string | null;
  thinking_level: ThinkingLevel;
};

export type ModelSettings = Record<ModelTierKey, ModelTierSetting>;

export type PiModel = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
};

export type ModelSettingsResponse = {
  models: PiModel[];
  settings: ModelSettings;
  rpc_status: "ready" | "error";
  rpc_error: string | null;
};

export type StartNodeData =
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
