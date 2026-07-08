import "@testing-library/jest-dom";

Object.defineProperty(window, "scrollTo", {
  value: () => {},
  configurable: true,
});
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", {
  value: ResizeObserverMock,
  configurable: true,
  writable: true,
});

window.matchMedia ??= () =>
  ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  value: () => null,
  configurable: true,
});

if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function close() {
    this.open = false;
  };
}
