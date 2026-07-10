import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  executeProjectGitAction,
  getProjectGitDiff,
  getProjectGitStatus,
} from "../api/client";
import type {
  GitAction,
  GitDiff,
  GitDiffArea,
  GitExpansionPhase,
  GitStatus,
} from "../types/api";
import { readError } from "../utils/format";

export function useProjectGit(projectId: string | null) {
  const [phase, setPhase] = useState<GitExpansionPhase>("collapsed");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<{
    path: string;
    area: GitDiffArea;
  } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const statusRequest = useRef(0);

  const applyStatus = useCallback((next: GitStatus) => {
    setStatus(next);
    setSelectedPaths((current) => {
      const available = new Set(next.files.map((file) => file.path));
      return new Set([...current].filter((path) => available.has(path)));
    });
  }, []);

  const load = useCallback(async () => {
    if (!projectId) {
      setStatus(null);
      return;
    }
    const request = ++statusRequest.current;
    try {
      const next = await getProjectGitStatus(projectId);
      if (request !== statusRequest.current) return;
      applyStatus(next);
      setError(null);
    } catch (reason) {
      setError(readError(reason));
    }
  }, [applyStatus, projectId]);

  useEffect(() => {
    setPhase("collapsed");
    setDiff(null);
    setSelectedDiff(null);
    setSelectedPaths(new Set());
    void load();
  }, [load, projectId]);

  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => void load(), 15_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load, projectId]);

  const toggleExpanded = useCallback(() => {
    setPhase((current) => (current === "collapsed" ? "expanded" : "collapsed"));
  }, []);

  const busyRef = useRef(false);

  const togglePath = useCallback((path: string) => {
    setSelectedPaths((current) => {
      const paths = [...current];
      const index = paths.indexOf(path);
      if (index >= 0) {
        paths.splice(index, 1);
      } else {
        paths.push(path);
      }
      return new Set(paths);
    });
  }, []);

  const selectDiff = useCallback(
    async (path: string, area: GitDiffArea) => {
      if (!projectId) return;
      setSelectedDiff({ path, area });
      try {
        setDiff(await getProjectGitDiff(projectId, path, area));
        setError(null);
      } catch (reason) {
        setDiff(null);
        setError(readError(reason));
      }
    },
    [projectId],
  );

  const action = useCallback(
    async (next: GitAction, result: string) => {
      if (!projectId || busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const request = ++statusRequest.current;
      try {
        const nextStatus = await executeProjectGitAction(projectId, next);
        if (request !== statusRequest.current) return false;
        applyStatus(nextStatus);
        setLastResult(result);
        setDiff(null);
        setSelectedDiff(null);
        return true;
      } catch (reason) {
        setError(readError(reason));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [applyStatus, projectId],
  );

  return useMemo(
    () => ({
      phase,
      status,
      diff,
      selectedDiff,
      selectedPaths,
      busy,
      error,
      lastResult,
      load,
      toggleExpanded,
      togglePath,
      selectDiff,
      action,
    }),
    [
      action,
      busy,
      diff,
      error,
      lastResult,
      load,
      phase,
      selectDiff,
      selectedDiff,
      selectedPaths,
      status,
      toggleExpanded,
      togglePath,
    ],
  );
}
