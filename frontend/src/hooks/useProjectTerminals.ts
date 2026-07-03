import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createProjectTerminal,
  deleteProjectTerminal,
  getProjectTerminals,
  getTerminalCommandProfiles,
  putTerminalCommandProfiles,
} from "../api/client";
import type {
  TerminalCommandProfile,
  TerminalCommandProfileDraft,
  TerminalSession,
} from "../types/api";
import { readError } from "../utils/format";

const PI_LOGIN_COMMAND = "pi --no-session --no-extensions --no-context-files";

export function useProjectTerminals(
  selectedProjectId: string | null,
  terminalDisabled: boolean,
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
  const piLoginSessionRef = useRef<TerminalSession | null>(null);
  piLoginSessionRef.current = piLoginSession;

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

  const load = useCallback(async () => {
    if (!selectedProjectId) {
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
  }, [selectedProjectId]);

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
      toggleCollapsed,
    ],
  );
}
