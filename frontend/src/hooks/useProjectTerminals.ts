import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createProjectTerminal,
  deleteProjectTerminal,
  getTerminalAccessStatus,
  getProjectTerminals,
  getTerminalCommandProfiles,
  putTerminalCommandProfiles,
  unlockTerminalAccess,
} from "../api/client";
import type {
  TerminalAccessStatus,
  TerminalCommandProfile,
  TerminalCommandProfileDraft,
  TerminalSession,
} from "../types/api";
import { readError } from "../utils/format";

const PI_LOGIN_COMMAND = "pi --no-session --no-extensions --no-context-files";
const MAX_TIMEOUT_MS = 2_147_483_647;

export function useProjectTerminals(
  selectedProjectId: string | null,
  terminalBlockedReason: string | undefined,
  terminalAccessRequired: boolean,
) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [commandProfiles, setCommandProfiles] = useState<
    TerminalCommandProfile[]
  >([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [piLoginSession, setPiLoginSession] = useState<TerminalSession | null>(
    null,
  );
  const [piLoginBusy, setPiLoginBusy] = useState(false);
  const [piLoginError, setPiLoginError] = useState<string | null>(null);
  const [terminalAccessStatus, setTerminalAccessStatus] =
    useState<TerminalAccessStatus | null>(null);
  const [terminalAccessBusy, setTerminalAccessBusy] = useState(false);
  const [terminalAccessError, setTerminalAccessError] = useState<string | null>(
    null,
  );
  const piLoginSessionRef = useRef<TerminalSession | null>(null);
  piLoginSessionRef.current = piLoginSession;
  const terminalAccessAuthorized =
    !terminalAccessRequired || terminalAccessStatus?.authorized === true;
  const terminalDisabledReason =
    terminalBlockedReason ??
    (terminalAccessRequired && !terminalAccessAuthorized
      ? "terminal-authorization-required"
      : undefined);
  const terminalDisabled = terminalDisabledReason !== undefined;

  useEffect(() => {
    setCollapsed(true);
    setPiLoginSession(null);
    setPiLoginError(null);
    return () => {
      const session = piLoginSessionRef.current;
      if (session) {
        void deleteProjectTerminal(session.project_id, session.id);
      }
    };
  }, [selectedProjectId]);

  useEffect(() => {
    const closeOnPageHide = () => {
      const session = piLoginSessionRef.current;
      if (!session) return;
      void fetch(
        `/api/projects/${encodeURIComponent(session.project_id)}/terminals/${encodeURIComponent(session.id)}`,
        { method: "DELETE", keepalive: true },
      );
    };
    window.addEventListener("pagehide", closeOnPageHide);
    return () => window.removeEventListener("pagehide", closeOnPageHide);
  }, []);

  const loadAccessStatus = useCallback(async () => {
    if (!selectedProjectId) {
      setTerminalAccessStatus(null);
      setTerminalAccessError(null);
      return;
    }
    if (!terminalAccessRequired) {
      setTerminalAccessStatus({
        required: false,
        authorized: true,
        expires_at: null,
      });
      setTerminalAccessError(null);
      return;
    }
    try {
      setTerminalAccessStatus(await getTerminalAccessStatus(selectedProjectId));
      setTerminalAccessError(null);
    } catch (reason) {
      setTerminalAccessError(readError(reason));
    }
  }, [selectedProjectId, terminalAccessRequired]);

  useEffect(() => {
    void loadAccessStatus();
  }, [loadAccessStatus]);

  useEffect(() => {
    if (!terminalAccessRequired || !terminalAccessStatus?.expires_at) return;
    const delay =
      new Date(terminalAccessStatus.expires_at).getTime() - Date.now() + 500;
    if (delay <= 0) {
      void loadAccessStatus();
      return;
    }
    const timeout = window.setTimeout(
      () => void loadAccessStatus(),
      Math.min(delay, MAX_TIMEOUT_MS),
    );
    return () => window.clearTimeout(timeout);
  }, [
    loadAccessStatus,
    terminalAccessRequired,
    terminalAccessStatus?.expires_at,
  ]);

  const load = useCallback(async () => {
    if (!selectedProjectId) {
      setSessions([]);
      setCommandProfiles([]);
      setActiveSessionId(null);
      return;
    }
    if (terminalDisabled) {
      setSessions([]);
      setCommandProfiles([]);
      setActiveSessionId(null);
      return;
    }
    try {
      const [nextSessions, nextProfiles] = await Promise.all([
        getProjectTerminals(selectedProjectId),
        getTerminalCommandProfiles(selectedProjectId),
      ]);
      setSessions(nextSessions);
      setCommandProfiles(nextProfiles);
      setActiveSessionId((current) =>
        current && nextSessions.some((session) => session.id === current)
          ? current
          : (nextSessions.at(0)?.id ?? null),
      );
      setError(null);
    } catch (reason) {
      setError(readError(reason));
    }
  }, [selectedProjectId, terminalDisabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => !current);
  }, []);

  const createTerminal = useCallback(
    async (command?: string | null, title?: string | null) => {
      if (!selectedProjectId || terminalDisabled) return;
      setBusy(true);
      setError(null);
      try {
        const session = await createProjectTerminal(selectedProjectId, {
          command,
          title,
        });
        setSessions((current) => [
          ...current.filter((candidate) => candidate.id !== session.id),
          session,
        ]);
        setActiveSessionId(session.id);
        setCollapsed(false);
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setBusy(false);
      }
    },
    [selectedProjectId, terminalDisabled],
  );

  const authorizeTerminalAccess = useCallback(
    async (key: string) => {
      if (!selectedProjectId) return false;
      setTerminalAccessBusy(true);
      setTerminalAccessError(null);
      try {
        const status = await unlockTerminalAccess(selectedProjectId, key);
        setTerminalAccessStatus(status);
        return status.authorized;
      } catch (reason) {
        setTerminalAccessError(readError(reason));
        return false;
      } finally {
        setTerminalAccessBusy(false);
      }
    },
    [selectedProjectId],
  );

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      if (!selectedProjectId) return;
      setBusy(true);
      setError(null);
      try {
        const nextSessions = await deleteProjectTerminal(
          selectedProjectId,
          terminalId,
        );
        setSessions(nextSessions);
        setActiveSessionId((current) =>
          current && nextSessions.some((session) => session.id === current)
            ? current
            : (nextSessions.at(0)?.id ?? null),
        );
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setBusy(false);
      }
    },
    [selectedProjectId],
  );

  const closePiLoginTerminal = useCallback(async () => {
    const session = piLoginSessionRef.current;
    if (!session) return;
    setPiLoginBusy(true);
    setPiLoginError(null);
    try {
      await deleteProjectTerminal(session.project_id, session.id);
      setPiLoginSession(null);
    } catch (reason) {
      setPiLoginError(readError(reason));
    } finally {
      setPiLoginBusy(false);
    }
  }, []);

  const startPiLoginTerminal = useCallback(async () => {
    if (!selectedProjectId || terminalDisabled || piLoginBusy) return;
    setPiLoginBusy(true);
    setPiLoginError(null);
    try {
      const previous = piLoginSessionRef.current;
      if (previous) {
        await deleteProjectTerminal(previous.project_id, previous.id);
        setPiLoginSession(null);
      }
      setPiLoginSession(
        await createProjectTerminal(selectedProjectId, {
          command: PI_LOGIN_COMMAND,
          title: "Pi 登录",
        }),
      );
    } catch (reason) {
      setPiLoginError(readError(reason));
    } finally {
      setPiLoginBusy(false);
    }
  }, [piLoginBusy, selectedProjectId, terminalDisabled]);

  const saveCommandProfiles = useCallback(
    async (profiles: TerminalCommandProfileDraft[]) => {
      if (!selectedProjectId) return;
      setBusy(true);
      setError(null);
      try {
        const saved = await putTerminalCommandProfiles(
          selectedProjectId,
          profiles,
        );
        setCommandProfiles(saved);
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setBusy(false);
      }
    },
    [selectedProjectId],
  );

  return useMemo(
    () => ({
      sessions,
      commandProfiles,
      activeSessionId,
      collapsed,
      busy,
      error,
      load,
      terminalDisabled,
      terminalDisabledReason,
      terminalAccessRequired,
      terminalAccessAuthorized,
      terminalAccessExpiresAt: terminalAccessStatus?.expires_at ?? null,
      terminalAccessBusy,
      terminalAccessError,
      authorizeTerminalAccess,
      toggleCollapsed,
      createTerminal,
      closeTerminal,
      selectTerminal: setActiveSessionId,
      saveCommandProfiles,
      piLoginSession,
      piLoginBusy,
      piLoginError,
      startPiLoginTerminal,
      closePiLoginTerminal,
    }),
    [
      activeSessionId,
      authorizeTerminalAccess,
      busy,
      closeTerminal,
      collapsed,
      commandProfiles,
      createTerminal,
      error,
      load,
      closePiLoginTerminal,
      piLoginBusy,
      piLoginError,
      piLoginSession,
      saveCommandProfiles,
      sessions,
      startPiLoginTerminal,
      terminalAccessAuthorized,
      terminalAccessBusy,
      terminalAccessError,
      terminalAccessRequired,
      terminalAccessStatus?.expires_at,
      terminalDisabled,
      terminalDisabledReason,
      toggleCollapsed,
    ],
  );
}
