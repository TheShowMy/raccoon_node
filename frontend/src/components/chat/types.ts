import type {
  FileReference,
  ImageAttachment,
  RequirementDraft,
} from "../../types/api";
import type { ProcessRow } from "../../utils/format";

export type ChatTranscriptNoticeAction = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "destructive";
};

export type ChatTranscriptItem =
  | {
      kind: "requirement_summary";
      id: string;
      requirementId: string;
      draft: RequirementDraft;
      status: "syncing" | "synced" | "failed";
      error?: string | null;
      created_at: string;
      onOpen?: () => void;
      onRetry?: () => void;
    }
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant" | "system";
      content: string;
      created_at: string;
      references?: FileReference[];
      images?: ImageAttachment[];
      assistantLabel?: string;
      processRows?: ProcessRow[];
    }
  | {
      kind: "process";
      id: string;
      created_at: string;
      rows: ProcessRow[];
      assistantLabel?: string;
    }
  | {
      kind: "notice";
      id: string;
      level: "info" | "warning";
      text: string;
      created_at: string;
      action?: ChatTranscriptNoticeAction;
    };
