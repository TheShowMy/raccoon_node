import { PixelButton } from "@pxlkit/ui-kit";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchAction } from "../../api/types";
import { getApi } from "../../api";

export function workbenchActionSourceKey(action: WorkbenchAction): string {
  if (action.kind === "git_discard")
    return `git_discard:${action.payload.path}`;
  if (action.kind === "terminal_close") {
    return `terminal_close:${action.payload.session_id}`;
  }
  return action.kind;
}

function revealSourceInsideWorkbench(source: HTMLElement) {
  const scrollArea = source.closest<HTMLElement>(
    "[data-scroll-key],.workbench-pane__content",
  );
  if (!scrollArea) return;
  const sourceRect = source.getBoundingClientRect();
  const areaRect = scrollArea.getBoundingClientRect();
  const safeBottom = areaRect.bottom - 96;
  if (sourceRect.top < areaRect.top) {
    scrollArea.scrollTop -= areaRect.top - sourceRect.top;
  } else if (sourceRect.bottom > safeBottom) {
    scrollArea.scrollTop += sourceRect.bottom - safeBottom;
  }
}

/** 普通工作台底部悬浮确认 Dock；绝对定位，不参与 pane 几何与滚动高度。 */
export function WorkbenchActionDock({
  actions,
}: {
  actions: WorkbenchAction[];
}) {
  const sorted = useMemo(
    () => [...actions].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [actions],
  );
  const pending = sorted.filter((action) => action.state === "awaiting");
  const previousStates = useRef(
    new Map(sorted.map((action) => [action.id, action.state])),
  );
  const [resultId, setResultId] = useState<string | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const confirmMutation = useMutation({
    mutationFn: (current: WorkbenchAction) =>
      getApi().confirmWorkbenchAction({
        action_id: current.id,
        confirm_token: current.confirm_token,
      }),
  });
  const cancelMutation = useMutation({
    mutationFn: (actionId: string) => getApi().cancelWorkbenchAction(actionId),
  });
  const mutationPending = confirmMutation.isPending || cancelMutation.isPending;

  useEffect(() => {
    for (const action of sorted) {
      const previous = previousStates.current.get(action.id);
      if (previous === "awaiting" && action.state !== "awaiting") {
        setResultId(action.id);
      }
    }
    previousStates.current = new Map(
      sorted.map((action) => [action.id, action.state]),
    );
  }, [sorted]);

  useEffect(() => {
    if (!resultId) return;
    const timer = window.setTimeout(() => setResultId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [resultId]);

  const action =
    pending[0] ?? sorted.find((item) => item.id === resultId) ?? null;
  useEffect(() => {
    if (!action || action.state !== "awaiting") return;
    const root = dockRef.current?.closest(".tool-workbench");
    const key = workbenchActionSourceKey(action);
    const source = [
      ...(root?.querySelectorAll<HTMLElement>("[data-action-source]") ?? []),
    ].find((element) => element.dataset.actionSource === key);
    if (source) revealSourceInsideWorkbench(source);
  }, [action]);

  if (!action) return null;
  const awaiting = action.state === "awaiting";
  const ok = action.result?.ok ?? false;
  return (
    <section
      ref={dockRef}
      className="workbench-action-dock px-cut px-shadowed-sm"
      data-tone={awaiting ? "red" : ok ? "green" : "gray"}
      data-action-kind={action.kind}
      aria-label={
        awaiting ? `危险操作确认:${action.title}` : `操作结果:${action.title}`
      }
    >
      <div className="workbench-action-dock__body">
        <strong>
          {awaiting ? "操作确认" : "操作结果"} · {action.title}
        </strong>
        <span>{awaiting ? action.impact : action.result?.message}</span>
      </div>
      {pending.length > 1 ? (
        <span className="workbench-action-dock__queue">
          另有 {pending.length - 1} 项待确认
        </span>
      ) : null}
      {awaiting ? (
        <div className="workbench-action-dock__actions">
          <PixelButton
            size="sm"
            tone="red"
            disabled={mutationPending}
            onClick={() => confirmMutation.mutate(action)}
          >
            确认执行
          </PixelButton>
          <PixelButton
            size="sm"
            variant="outline"
            disabled={mutationPending}
            onClick={() => cancelMutation.mutate(action.id)}
          >
            取消
          </PixelButton>
        </div>
      ) : null}
    </section>
  );
}
