import type {
  BasicSettings,
  BasicSettingsUpdate,
  GitAction,
  GitDiff,
  GitDiffArea,
  GitStatus,
  ModelSettings,
  ModelTierKey,
  ModelTierSetting,
  PiModel,
  Project,
  ProjectTokenUsage,
  SettingsPage,
  TerminalCommandProfile,
  TerminalSession,
} from "./api";

export interface SettingsWorkbenchModel {
  page: SettingsPage;
  basicSettings: BasicSettings | null;
  basicError: string | null;
  savingBasic: boolean;
  savingTheme: boolean;
  modelSettings: ModelSettings;
  models: PiModel[];
  modelRpcStatus: "idle" | "loading" | "ready" | "reconnecting" | "error";
  modelError: string | null;
  savingModels: boolean;
  terminalDisabled: boolean;
  terminalAccessRequired: boolean;
  terminalAccessAuthorized: boolean;
  terminalAccessBusy: boolean;
  terminalAccessError: string | null;
  piLoginSession: TerminalSession | null;
  piLoginBusy: boolean;
  piLoginError: string | null;
  needsModelOnboarding: boolean;
  modelDraftComplete: boolean;
  modelSavedComplete: boolean;
  onOpenBasic: () => void;
  onOpenModels: () => void;
  onBasicChange: (settings: BasicSettings) => void;
  onThemeChange: (
    update: Pick<BasicSettingsUpdate, "theme_pack" | "theme_mode">,
  ) => Promise<void>;
  onSaveBasic: (confirmedExternal?: boolean) => Promise<BasicSettings | null>;
  onModelChange: (tier: ModelTierKey, setting: ModelTierSetting) => void;
  onSaveModels: () => Promise<void>;
  onReloadModels: () => Promise<void>;
  onAuthorizeTerminalAccess: (key: string) => Promise<boolean>;
  onStartPiLogin: () => Promise<void>;
  onClosePiLogin: () => Promise<void>;
}

export interface TerminalWorkbenchModel {
  project: Project;
  sessions: TerminalSession[];
  activeSessionId: string | null;
  commandProfiles: TerminalCommandProfile[];
  busy: boolean;
  error: string | null;
  terminalDisabled: boolean;
  terminalDisabledReason?: string;
  terminalAccessRequired: boolean;
  terminalAccessAuthorized: boolean;
  terminalAccessBusy: boolean;
  terminalAccessError: string | null;
  onAuthorizeTerminalAccess: (key: string) => Promise<boolean>;
  onCreateTerminal: (
    command?: string | null,
    title?: string | null,
  ) => Promise<void>;
  onCloseTerminal: (terminalId: string) => Promise<void>;
  onSelectTerminal: (terminalId: string) => void;
}

export interface GitWorkbenchModel {
  status: GitStatus | null;
  diff: GitDiff | null;
  busy: boolean;
  error: string | null;
  lastResult: string | null;
  onRefresh: () => Promise<void>;
  onSelectDiff: (path: string, area: GitDiffArea) => Promise<void>;
  onAction: (action: GitAction, result: string) => Promise<boolean>;
}

export interface TokenWorkbenchModel {
  usage: ProjectTokenUsage | null;
}
