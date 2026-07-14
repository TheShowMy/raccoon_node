import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createProjectTerminal,
  deleteProjectTerminal,
  getTerminalAccessStatus,
  getProjectTerminals,
  getTerminalCommandProfiles,
  unlockTerminalAccess,
} from "../api/client";
import type {
  TerminalAccessStatus,
  TerminalCommandProfile,
  TerminalSession,
} from "../types/api";
import { readError } from "../utils/format";

const PI_LOGIN_COMMAND = "pi --no-session --no-extensions --no-context-files";
const MAX_TIMEOUT_MS = 2_147_483_647;

export function useProjectTerminals(
  terminalBlockedReason: string | undefined,
  terminalAccessRequired: boolean,
) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [commandProfiles, setCommandProfiles] = useState<
    TerminalCommandProfile[]
  >([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
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
    setPiLoginSession(null);
    setPiLoginError(null);
    return () => {
      const session = piLoginSessionRef.current;
      if (session) {
        void deleteProjectTerminal(session.id);
      }
    };
  }, []);

  useEffect(() => {
    const closeOnPageHide = () => {
      const session = piLoginSessionRef.current;
      if (!session) return;
      void fetch(`/api/terminals/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
        keepalive: true,
      });
    };
    window.addEventListener("pagehide", closeOnPageHide);
    return () => window.removeEventListener("pagehide", closeOnPageHide);
  }, []);

  const loadAccessStatus = useCallback(async () => {
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
      setTerminalAccessStatus(await getTerminalAccessStatus());
      setTerminalAccessError(null);
    } catch (reason) {
      setTerminalAccessError(readError(reason));
    }
  }, [terminalAccessRequired]);

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
    if (terminalDisabled) {
      setSessions([]);
      setCommandProfiles([]);
      setActiveSessionId(null);
      return;
    }
    try {
      const [nextSessions, nextProfiles] = await Promise.all([
        getProjectTerminals(),
        getTerminalCommandProfiles(),
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
  }, [terminalDisabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const createTerminal = useCallback(
    async (command?: string | null, title?: string | null) => {
      if (terminalDisabled) return;
      setBusy(true);
      setError(null);
      try {
        const session = await createProjectTerminal({
          command,
          title,
        });
        setSessions((current) => [
          ...current.filter((candidate) => candidate.id !== session.id),
          session,
        ]);
        setActiveSessionId(session.id);
      } catch (reason) {
        setError(readError(reason));
      } finally {
        setBusy(false);
      }
    },
    [terminalDisabled],
  );

  const authorizeTerminalAccess = useCallback(async (key: string) => {
    setTerminalAccessBusy(true);
    setTerminalAccessError(null);
    try {
      const status = await unlockTerminalAccess(key);
      setTerminalAccessStatus(status);
      return status.authorized;
    } catch (reason) {
      setTerminalAccessError(readError(reason));
      return false;
    } finally {
      setTerminalAccessBusy(false);
    }
  }, []);

  const closeTerminal = useCallback(async (terminalId: string) => {
    setBusy(true);
    setError(null);
    try {
      const nextSessions = await deleteProjectTerminal(terminalId);
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
  }, []);

  const closePiLoginTerminal = useCallback(async () => {
    const session = piLoginSessionRef.current;
    if (!session) return;
    setPiLoginBusy(true);
    setPiLoginError(null);
    try {
      await deleteProjectTerminal(session.id);
      setPiLoginSession(null);
    } catch (reason) {
      setPiLoginError(readError(reason));
    } finally {
      setPiLoginBusy(false);
    }
  }, []);

  const startPiLoginTerminal = useCallback(async () => {
    if (terminalDisabled || piLoginBusy) return;
    setPiLoginBusy(true);
    setPiLoginError(null);
    try {
      const previous = piLoginSessionRef.current;
      if (previous) {
        await deleteProjectTerminal(previous.id);
        setPiLoginSession(null);
      }
      setPiLoginSession(
        await createProjectTerminal({
          command: PI_LOGIN_COMMAND,
          title: "Pi 登录",
        }),
      );
    } catch (reason) {
      setPiLoginError(readError(reason));
    } finally {
      setPiLoginBusy(false);
    }
  }, [piLoginBusy, terminalDisabled]);

  return useMemo(
    () => ({
      sessions,
      commandProfiles,
      activeSessionId,
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
      createTerminal,
      closeTerminal,
      selectTerminal: setActiveSessionId,
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
      commandProfiles,
      createTerminal,
      error,
      load,
      closePiLoginTerminal,
      piLoginBusy,
      piLoginError,
      piLoginSession,
      sessions,
      startPiLoginTerminal,
      terminalAccessAuthorized,
      terminalAccessBusy,
      terminalAccessError,
      terminalAccessRequired,
      terminalAccessStatus?.expires_at,
      terminalDisabled,
      terminalDisabledReason,
    ],
  );
}
