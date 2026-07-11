import { useEffect } from "react";
import type { MainPanelKind } from "../canvas/orbitNodes";

export function usePanelEscape(
  openPanel: MainPanelKind | null,
  onClose: () => void,
) {
  useEffect(() => {
    if (!openPanel) return;

    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [onClose, openPanel]);
}
