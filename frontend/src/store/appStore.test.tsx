import { describe, expect, it } from "vitest";
import { AppStore } from "./appStore";

describe("AppStore", () => {
  it("opens and closes panels", () => {
    const store = new AppStore();
    expect(store.getSnapshot().openPanel).toBeNull();

    store.openPanel("settings");
    expect(store.getSnapshot().openPanel).toBe("settings");
    expect(store.getSnapshot().panelPhase).toBe("focusing");

    store.focusPanelComplete();
    expect(store.getSnapshot().panelPhase).toBe("content");

    store.closePanel();
    expect(store.getSnapshot().openPanel).toBe("settings");
    expect(store.getSnapshot().panelPhase).toBe("closing");

    store.closePanelComplete();
    expect(store.getSnapshot().openPanel).toBeNull();
    expect(store.getSnapshot().panelPhase).toBe("shell");
  });

  it("toggles token usage expansion", () => {
    const store = new AppStore();
    expect(store.getSnapshot().tokenUsageExpanded).toBe(false);

    store.toggleTokenUsageExpanded();
    expect(store.getSnapshot().tokenUsageExpanded).toBe(true);

    store.toggleTokenUsageExpanded();
    expect(store.getSnapshot().tokenUsageExpanded).toBe(false);
  });

  it("does not emit when state is unchanged", () => {
    const store = new AppStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });

    store.focusPanelComplete();
    store.closePanel();
    store.closePanelComplete();
    expect(calls).toBe(0);
  });
});
