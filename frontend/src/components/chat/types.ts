import type { FileReference, ImageAttachment } from "../../types/api";
import type { ProcessRow } from "../../utils/format";

export type ChatTranscriptNoticeAction = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "destructive";
};

export type ChatTranscriptItem =
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
