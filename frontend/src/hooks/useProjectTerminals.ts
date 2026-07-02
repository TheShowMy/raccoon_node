import { useCallback, useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    setCollapsed(true);
  }, [selectedProjectId]);

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
      saveCommandProfiles,
      sessions,
      toggleCollapsed,
    ],
  );
}
