import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { MainPanelKind } from "../canvas/orbitNodes";

export interface AppUiState {
  openPanel: MainPanelKind | null;
  panelPhase: "shell" | "focusing" | "content" | "closing";
}

const INITIAL_UI_STATE: AppUiState = {
  openPanel: null,
  panelPhase: "shell",
};

class Store {
  private state = INITIAL_UI_STATE;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): AppUiState {
    return this.state;
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setState(partial: Partial<AppUiState>) {
    const next = { ...this.state, ...partial };
    if (
      next.openPanel === this.state.openPanel &&
      next.panelPhase === this.state.panelPhase
    ) {
      return;
    }
    this.state = next;
    this.emit();
  }

  openPanel(panel: MainPanelKind) {
    this.setState({ openPanel: panel, panelPhase: "focusing" });
  }

  focusPanelComplete() {
    if (this.state.openPanel && this.state.panelPhase === "focusing") {
      this.setState({ panelPhase: "content" });
    }
  }

  closePanel() {
    if (this.state.openPanel && this.state.panelPhase !== "closing") {
      this.setState({ panelPhase: "closing" });
    }
  }

  closePanelComplete() {
    if (this.state.openPanel && this.state.panelPhase === "closing") {
      this.setState({ openPanel: null, panelPhase: "shell" });
    }
  }
}

const appStore = new Store();

const AppStoreContext = createContext<Store>(appStore);

export function AppStoreProvider({
  store = appStore,
  children,
}: {
  store?: Store;
  children: React.ReactNode;
}) {
  const value = useMemo(() => store, [store]);
  return (
    <AppStoreContext.Provider value={value}>
      {children}
    </AppStoreContext.Provider>
  );
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => aRecord[key] === bRecord[key]);
}

export function useAppUiState<Selected>(
  selector: (state: AppUiState) => Selected,
): Selected {
  const store = useContext(AppStoreContext);
  const last = useRef<Selected | undefined>(undefined);
  const wrappedSelector = useCallback(() => {
    const next = selector(store.getSnapshot());
    const prev = last.current;
    if (prev !== undefined && shallowEqual(prev, next)) {
      return prev;
    }
    last.current = next;
    return next;
  }, [store, selector]);
  return useSyncExternalStore(
    store.subscribe.bind(store),
    wrappedSelector,
    wrappedSelector,
  );
}

export function useAppStoreActions(): Pick<
  Store,
  "openPanel" | "closePanel" | "closePanelComplete" | "focusPanelComplete"
> {
  const store = useContext(AppStoreContext);
  return useMemo(
    () => ({
      openPanel: store.openPanel.bind(store),
      closePanel: store.closePanel.bind(store),
      closePanelComplete: store.closePanelComplete.bind(store),
      focusPanelComplete: store.focusPanelComplete.bind(store),
    }),
    [store],
  );
}

export { Store as AppStore, appStore };
