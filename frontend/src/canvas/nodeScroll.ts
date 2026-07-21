import { useCanvasStore } from "../store/canvasStore";

const SCROLLABLE_SELECTOR = [
  ".chat-list",
  ".chat-node__content--scroll",
  ".req-list__scroll",
  ".ftree",
  ".fresults",
  ".fpreview",
  ".role-list",
  ".workbench-pane__content",
  ".git-change-list",
  ".dnode__sections",
  ".dnode__diff",
  ".workbench-node__body",
].join(",");

function elementKey(element: HTMLElement, scope: string): string | null {
  // 列表行内滚动区优先归属行 id；列表自身与 pane 走 data-scroll-key
  const rowId = element.closest<HTMLElement>(".chat-row")?.dataset.id;
  const scrollKey =
    element.dataset.scrollKey ??
    element.closest<HTMLElement>("[data-scroll-key]")?.dataset.scrollKey;
  const nodeId = element.closest<HTMLElement>(".react-flow__node")?.dataset.id;
  const workbench =
    element.closest<HTMLElement>("[data-workbench]")?.dataset.workbench;
  const ownerId = rowId ?? scrollKey ?? nodeId ?? workbench;
  if (!ownerId) return null;
  const scrollClass = [...element.classList]
    .filter((name) => !["nodrag", "nowheel"].includes(name))
    .sort()
    .join(".");
  return `${scope}:${ownerId}:${scrollClass || "content"}`;
}

/** React onScrollCapture 入口：按画布/工作台、节点/面板和滚动区域保存位置。 */
export function persistScrollPosition(
  target: EventTarget | null,
  scope: string,
) {
  if (
    !(target instanceof HTMLElement) ||
    !target.matches(SCROLLABLE_SELECTOR)
  ) {
    return;
  }
  const key = elementKey(target, scope);
  if (key) useCanvasStore.getState().setScrollPosition(key, target.scrollTop);
}

/** 节点、面板或工作台重新挂载后恢复内部滚动。 */
export function restoreScrollPositions(root: HTMLElement, scope: string) {
  const saved = useCanvasStore.getState().scrollPositions;
  if (root.matches(SCROLLABLE_SELECTOR)) {
    const rootKey = elementKey(root, scope);
    if (rootKey && saved[rootKey] !== undefined)
      root.scrollTop = saved[rootKey];
  }
  for (const element of root.querySelectorAll<HTMLElement>(
    SCROLLABLE_SELECTOR,
  )) {
    const key = elementKey(element, scope);
    if (key && saved[key] !== undefined) element.scrollTop = saved[key];
  }
}
